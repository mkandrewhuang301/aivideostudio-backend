import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { getFirebaseAdmin } from '../firebase';
import { evictAuthCache } from '../middleware/auth';

export type MergeErrorCode = 'ALREADY_MERGED' | 'SAME_ACCOUNT' | 'MERGE_FAILED';

export class MergeError extends Error {
  constructor(public readonly code: MergeErrorCode) {
    super(code);
    this.name = 'MergeError';
  }
}

interface MergeResultRow {
  target_firebase_uid: string;
  transferred_credits: number | string;
  excluded_free_credits: number | string;
}

/**
 * Atomically folds an anonymous database account into an existing account.
 *
 * Existing credit_transactions rows remain immutable. The balance movement is
 * represented by paired merge_transfer entries, while the source user remains
 * as a banned, stripped-down tombstone anchoring the excluded free-grant ledger
 * and user_merges audit foreign keys.
 */
export async function mergeUser(
  fromDbUserId: string,
  toDbUserId: string,
  fromFirebaseUid: string,
): Promise<void> {
  if (fromDbUserId === toDbUserId) {
    throw new MergeError('SAME_ACCOUNT');
  }

  const priorMerge = await db.execute(sql`
    SELECT 1
    FROM user_merges
    WHERE from_user_id = ${fromDbUserId}::uuid
    LIMIT 1
  `);
  if (priorMerge.rows?.length) {
    throw new MergeError('ALREADY_MERGED');
  }

  const mergeId = randomUUID();
  const result = await db.execute(sql`
    WITH ledger_totals AS (
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'free_grant'), 0)::integer AS free_granted,
        COALESCE(SUM(amount) FILTER (
          WHERE type IN ('generation_deduct', 'generation_refund')
        ), 0)::integer AS generation_activity
      FROM credit_transactions
      WHERE user_id = ${fromDbUserId}::uuid
    ),
    raw_snapshot AS (
      SELECT
        source.id AS from_user_id,
        target.id AS to_user_id,
        target.firebase_uid AS target_firebase_uid,
        source.credits_balance AS source_balance,
        GREATEST(
          0,
          LEAST(
            source.credits_balance,
            ledger_totals.free_granted + ledger_totals.generation_activity
          )
        )::integer AS excluded_free_credits
      FROM users AS source
      CROSS JOIN users AS target
      CROSS JOIN ledger_totals
      WHERE source.id = ${fromDbUserId}::uuid
        AND target.id = ${toDbUserId}::uuid
    ),
    snapshot AS (
      SELECT
        *,
        GREATEST(0, source_balance - excluded_free_credits)::integer AS transferred_credits
      FROM raw_snapshot
    ),
    record_merge AS (
      INSERT INTO user_merges (
        id,
        from_user_id,
        to_user_id,
        transferred_credits,
        excluded_free_credits,
        created_at
      )
      SELECT
        ${mergeId}::uuid,
        from_user_id,
        to_user_id,
        transferred_credits,
        excluded_free_credits,
        now()
      FROM snapshot
      ON CONFLICT (from_user_id) DO NOTHING
      RETURNING id, from_user_id, to_user_id, transferred_credits, excluded_free_credits
    ),
    record_transfer AS (
      INSERT INTO credit_transactions (user_id, amount, type, reference_id, created_at)
      SELECT from_user_id, -transferred_credits, 'merge_transfer'::credit_transaction_type, id::text, now()
      FROM record_merge
      WHERE transferred_credits > 0
      UNION ALL
      SELECT to_user_id, transferred_credits, 'merge_transfer'::credit_transaction_type, id::text, now()
      FROM record_merge
      WHERE transferred_credits > 0
      RETURNING id
    ),
    move_generations AS (
      UPDATE generations AS item
      SET user_id = merge.to_user_id
      FROM record_merge AS merge
      WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    move_reference_uploads AS (
      UPDATE reference_uploads AS item
      SET user_id = merge.to_user_id
      FROM record_merge AS merge
      WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    move_projects AS (
      UPDATE projects AS item
      SET user_id = merge.to_user_id,
          updated_at = now()
      FROM record_merge AS merge
      WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    update_target AS (
      UPDATE users AS target
      SET credits_balance = target.credits_balance + merge.transferred_credits,
          entitlement_level = COALESCE(target.entitlement_level, source.entitlement_level),
          subscription_product_id = COALESCE(target.subscription_product_id, source.subscription_product_id),
          subscription_started_at = COALESCE(target.subscription_started_at, source.subscription_started_at),
          subscription_allotment = GREATEST(target.subscription_allotment, source.subscription_allotment),
          total_generations = target.total_generations + source.total_generations,
          moderation_strikes = GREATEST(target.moderation_strikes, source.moderation_strikes),
          banned = target.banned OR source.banned,
          updated_at = now()
      FROM record_merge AS merge, users AS source
      WHERE target.id = merge.to_user_id
        AND source.id = merge.from_user_id
      RETURNING target.firebase_uid
    ),
    tombstone_source AS (
      UPDATE users AS source
      SET email = NULL,
          credits_balance = merge.excluded_free_credits,
          apns_device_token = NULL,
          entitlement_level = NULL,
          subscription_allotment = 0,
          revenuecat_customer_id = NULL,
          subscription_product_id = NULL,
          subscription_started_at = NULL,
          display_name = NULL,
          total_generations = 0,
          last_active_at = NULL,
          banned = TRUE,
          moderation_strikes = 0,
          onboarding_preferences = NULL,
          face_consent_at = NULL,
          updated_at = now()
      FROM record_merge AS merge
      WHERE source.id = merge.from_user_id
      RETURNING source.id
    )
    SELECT
      target.firebase_uid AS target_firebase_uid,
      merge.transferred_credits,
      merge.excluded_free_credits
    FROM record_merge AS merge
    JOIN update_target AS target ON TRUE
    JOIN tombstone_source AS source ON TRUE
  `);

  const mergeResult = result.rows?.[0] as unknown as MergeResultRow | undefined;
  if (!mergeResult) {
    // The unique source constraint is the final race-safe idempotency gate. An
    // empty result after the pre-check means another request won that race (or
    // one of the account rows no longer exists); never attempt partial cleanup.
    throw new MergeError('ALREADY_MERGED');
  }

  try {
    await getFirebaseAdmin().auth.deleteUser(fromFirebaseUid);
  } catch (error) {
    // The database merge is committed. The tombstone is banned, so even a
    // still-valid anonymous token cannot use the old account while cleanup is
    // retried operationally.
    console.error(`[user-merge] CRITICAL: Firebase user deletion failed for uid ${fromFirebaseUid}:`, error);
  }

  evictAuthCache(fromFirebaseUid);
  evictAuthCache(mergeResult.target_firebase_uid);
}
