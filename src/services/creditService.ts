// src/services/creditService.ts
// Credit ledger operations: atomic deduction, grant, balance computation with top-up expiry enforcement.
// CLAUDE.md Rule 1: credit deduction is atomic — UPDATE WHERE credits_balance >= cost.
// D-22: credit_transactions is append-only — never update or delete rows.

import { db } from '../db/client';
import { creditTransactions } from '../db/schema';
import { sql } from 'drizzle-orm';

export interface UserBalance {
  credits_balance: number;
  subscription_allotment: number;
  active_topup_balance: number;
  entitlement_level: string | null;
}

/**
 * Atomically deducts `cost` credits from the user's balance.
 * Uses a single UPDATE WHERE credits_balance >= cost — the WHERE clause IS the atomic check.
 * NEVER do SELECT then UPDATE (CLAUDE.md Rule 1).
 * Returns true if deduction succeeded; false if insufficient credits.
 * On success, appends a generation_deduct ledger row.
 *
 * Perf: the UPDATE and the ledger INSERT used to be 2 separate Neon HTTP round trips (also not
 * transactional together — a crash between them could lose the ledger row). A data-modifying
 * CTE does both in a single statement/round trip and keeps them atomic with each other.
 */
export async function deductCredits(userId: string, cost: number): Promise<boolean> {
  const result = await db.execute(sql`
    WITH deducted AS (
      UPDATE users
      SET credits_balance = credits_balance - ${cost},
          updated_at = now()
      WHERE id = ${userId}::uuid
        AND credits_balance >= ${cost}
      RETURNING id
    )
    INSERT INTO credit_transactions (user_id, amount, type)
    SELECT id, ${-cost}, 'generation_deduct'::credit_transaction_type FROM deducted
    RETURNING user_id
  `);

  return Boolean(result.rows && result.rows.length > 0);
}

/**
 * Grants credits to the user. Used by RevenueCat webhook handler for INITIAL_PURCHASE,
 * RENEWAL (subscription_grant), NON_RENEWING_PURCHASE (topup_grant).
 * For subscription_grant type: also resets subscription_allotment to `amount`
 * (D-08: subscription credits do not roll over; allotment resets each billing period).
 * For topup_grant type: sets expires_at on the ledger row (90-day expiry per D-08).
 */
export async function grantCredits(
  userId: string,
  amount: number,
  type: 'subscription_grant' | 'topup_grant',
  referenceId: string,
  expiresAt?: Date,
): Promise<void> {
  // Update balance + subscription_allotment if this is a subscription grant
  if (type === 'subscription_grant') {
    await db.execute(sql`
      UPDATE users
      SET credits_balance = credits_balance + ${amount},
          subscription_allotment = ${amount},
          updated_at = now()
      WHERE id = ${userId}::uuid
    `);
  } else {
    await db.execute(sql`
      UPDATE users
      SET credits_balance = credits_balance + ${amount},
          updated_at = now()
      WHERE id = ${userId}::uuid
    `);
  }

  // Append ledger row (D-22: append-only)
  await db.insert(creditTransactions).values({
    user_id: userId,
    amount,
    type,
    reference_id: referenceId,
    expires_at: expiresAt ?? null,
  });
}

/**
 * Claws back refunded credits. Used by RevenueCat REFUND webhook.
 * Deducts up to the refunded amount (never goes below 0 — clamp to current balance if needed).
 * Appends a refund_clawback ledger row.
 */
export async function clawbackCredits(
  userId: string,
  amount: number,
  referenceId: string,
): Promise<void> {
  // Clamp deduction to current balance to avoid going negative
  // (edge case: user already spent the credits before refund fires)
  await db.execute(sql`
    UPDATE users
    SET credits_balance = GREATEST(0, credits_balance - ${amount}),
        updated_at = now()
    WHERE id = ${userId}::uuid
  `);

  await db.insert(creditTransactions).values({
    user_id: userId,
    amount: -amount,
    type: 'refund_clawback',
    reference_id: referenceId,
  });
}

/**
 * Refunds credits to a user for a failed, orphaned, or stalled generation.
 * Used by the Replicate webhook failure path and the BullMQ reaper.
 * Appends a generation_refund ledger row (D-22: append-only).
 */
export async function refundCredits(
  userId: string,
  amount: number,
  referenceId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE users
    SET credits_balance = credits_balance + ${amount},
        updated_at = now()
    WHERE id = ${userId}::uuid
  `);

  await db.insert(creditTransactions).values({
    user_id: userId,
    amount,
    type: 'generation_refund',
    reference_id: referenceId,
  });
}

interface CombinedBalanceRow {
  credits_balance: number;
  subscription_allotment: number;
  entitlement_level: string | null;
  active_topup_balance: string | number | null;
  expired_topups: unknown;
}

// Perf: this used to be 3 serial Neon HTTP round trips (each is a full network hop on the
// neon-http driver, no pooled connection). The common case — no expired top-ups — now takes 1.
// Only when expired top-ups exist do we fall back to the clawback loop + a second combined query.
const COMBINED_BALANCE_QUERY = (userId: string) => sql`
  WITH effective_ledger_users AS (
    SELECT ${userId}::uuid AS id
    UNION ALL
    SELECT from_user_id
    FROM user_merges
    WHERE to_user_id = ${userId}::uuid
  )
  SELECT u.credits_balance, u.subscription_allotment, u.entitlement_level,
    COALESCE((
      SELECT SUM(amount) FROM credit_transactions
      WHERE user_id IN (SELECT id FROM effective_ledger_users)
        AND type = 'topup_grant'
        AND (expires_at IS NULL OR expires_at > now())
    ), 0) AS active_topup_balance,
    COALESCE((
      SELECT json_agg(json_build_object('id', ct.id, 'amount', ct.amount))
      FROM credit_transactions ct
      WHERE ct.user_id IN (SELECT id FROM effective_ledger_users)
        AND ct.type = 'topup_grant'
        AND ct.expires_at IS NOT NULL AND ct.expires_at < now()
        AND NOT EXISTS (
          SELECT 1 FROM credit_transactions cb
          WHERE cb.user_id IN (SELECT id FROM effective_ledger_users)
            AND cb.type = 'refund_clawback'
            AND cb.reference_id = ct.id::text
        )
    ), '[]'::json) AS expired_topups
  FROM users u WHERE u.id = ${userId}::uuid
`;

function parseExpiredTopups(raw: unknown): Array<{ id: string; amount: number }> {
  if (Array.isArray(raw)) return raw as Array<{ id: string; amount: number }>;
  if (typeof raw === 'string') return JSON.parse(raw);
  return [];
}

function toBalance(row: CombinedBalanceRow): UserBalance {
  const rawTopupBalance = row.active_topup_balance;
  return {
    credits_balance: row.credits_balance,
    subscription_allotment: row.subscription_allotment,
    active_topup_balance: rawTopupBalance != null ? Number(rawTopupBalance) : 0,
    entitlement_level: row.entitlement_level,
  };
}

/**
 * Fetches user balance data for GET /api/me.
 * Before returning, expires any stale topup_grant rows (expires_at < now()).
 * Stale rows are expired by inserting a refund_clawback row of opposite amount and
 * decrementing credits_balance (clamped to 0 — never goes negative).
 * Computes active_topup_balance from unexpired topup_grant rows after expiry. For
 * merged accounts, the append-only source ledger remains effective through the
 * user_merges audit row so transferred top-ups retain their original expiry.
 */
export async function getUserWithBalance(userId: string): Promise<UserBalance> {
  const result = await db.execute(COMBINED_BALANCE_QUERY(userId));
  const row = result.rows[0] as unknown as CombinedBalanceRow | undefined;

  if (!row) {
    throw new Error(`User ${userId} not found`);
  }

  const expiredTopups = parseExpiredTopups(row.expired_topups);
  if (expiredTopups.length === 0) {
    return toBalance(row);
  }

  // Rare path: expire stale top-up grants (clamped to avoid negative balance — pitfall 5:
  // user may have already spent the top-up credits before expiry), then re-fetch once.
  for (const topup of expiredTopups) {
    await db.execute(sql`
      UPDATE users
      SET credits_balance = GREATEST(0, credits_balance - ${topup.amount}),
          updated_at = now()
      WHERE id = ${userId}::uuid
    `);
    await db.insert(creditTransactions).values({
      user_id: userId,
      amount: -topup.amount,
      type: 'refund_clawback',
      reference_id: topup.id, // reference = the original topup_grant transaction row ID
    });
  }

  const refetched = await db.execute(COMBINED_BALANCE_QUERY(userId));
  const refetchedRow = refetched.rows[0] as unknown as CombinedBalanceRow | undefined;
  if (!refetchedRow) {
    throw new Error(`User ${userId} not found`);
  }
  return toBalance(refetchedRow);
}
