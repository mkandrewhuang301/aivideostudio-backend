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
 */
export async function deductCredits(userId: string, cost: number): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE users
    SET credits_balance = credits_balance - ${cost},
        updated_at = now()
    WHERE id = ${userId}::uuid
      AND credits_balance >= ${cost}
    RETURNING id
  `);

  if (!result.rows || result.rows.length === 0) {
    return false; // Insufficient credits — no update occurred
  }

  // Append ledger entry (D-22: append-only, never update)
  await db.insert(creditTransactions).values({
    user_id: userId,
    amount: -cost,
    type: 'generation_deduct',
  });

  return true;
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
 * Fetches user balance data for GET /api/me.
 * Before returning, expires any stale topup_grant rows (expires_at < now()).
 * Stale rows are expired by inserting a refund_clawback row of opposite amount and
 * decrementing credits_balance (clamped to 0 — never goes negative).
 * Computes active_topup_balance from unexpired topup_grant rows after expiry.
 */
export async function getUserWithBalance(userId: string): Promise<UserBalance> {
  // Step 1: Find topup_grant rows past their expiry that have not been clawed back yet.
  // A row is "clawed back" if there's a refund_clawback row whose reference_id = the topup row's id.
  const expiredTopups = await db.execute(sql`
    SELECT ct.id, ct.amount, ct.reference_id
    FROM credit_transactions ct
    WHERE ct.user_id = ${userId}::uuid
      AND ct.type = 'topup_grant'
      AND ct.expires_at IS NOT NULL
      AND ct.expires_at < now()
      AND NOT EXISTS (
        SELECT 1 FROM credit_transactions cb
        WHERE cb.user_id = ${userId}::uuid
          AND cb.type = 'refund_clawback'
          AND cb.reference_id = ct.id::text
      )
  `);

  for (const row of expiredTopups.rows as Array<{ id: string; amount: number; reference_id: string }>) {
    // Clamp to avoid negative balance (pitfall 5: user may have spent top-up credits already)
    await db.execute(sql`
      UPDATE users
      SET credits_balance = GREATEST(0, credits_balance - ${row.amount}),
          updated_at = now()
      WHERE id = ${userId}::uuid
    `);
    await db.insert(creditTransactions).values({
      user_id: userId,
      amount: -row.amount,
      type: 'refund_clawback',
      reference_id: row.id, // reference = the original topup_grant transaction row ID
    });
  }

  // Step 2: Fetch current user row after any expiry processing
  const userRows = await db.execute(sql`
    SELECT credits_balance, subscription_allotment, entitlement_level
    FROM users
    WHERE id = ${userId}::uuid
  `);

  const user = userRows.rows[0] as {
    credits_balance: number;
    subscription_allotment: number;
    entitlement_level: string | null;
  } | undefined;

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  // Step 3: Compute active_topup_balance from unexpired topup_grant rows
  const topupRows = await db.execute(sql`
    SELECT COALESCE(SUM(amount), 0) AS active_topup_balance
    FROM credit_transactions
    WHERE user_id = ${userId}::uuid
      AND type = 'topup_grant'
      AND (expires_at IS NULL OR expires_at > now())
  `);

  const rawTopupBalance = (topupRows.rows[0] as { active_topup_balance: string | null })
    ?.active_topup_balance;
  const active_topup_balance = rawTopupBalance != null ? Number(rawTopupBalance) : 0;

  return {
    credits_balance: user.credits_balance,
    subscription_allotment: user.subscription_allotment,
    active_topup_balance,
    entitlement_level: user.entitlement_level,
  };
}
