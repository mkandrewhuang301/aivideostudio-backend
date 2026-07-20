import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { db } from '../db/client';
import { queryDeviceCheckBit, updateDeviceCheckBit } from './deviceCheckService';

type FreeCreditsState = 'pending' | 'devicecheck_updated' | 'granted' | 'ineligible';

interface FreeCreditsStateRow {
  free_credits_state: FreeCreditsState;
}

async function loadState(dbUserId: string): Promise<FreeCreditsState> {
  const result = await db.execute(sql`
    SELECT free_credits_state
    FROM users
    WHERE id = ${dbUserId}::uuid
  `);
  const row = result.rows?.[0] as unknown as FreeCreditsStateRow | undefined;
  if (!row) throw new Error(`Cannot process free credits: user ${dbUserId} was not found`);
  return row.free_credits_state;
}

async function markIneligible(dbUserId: string): Promise<void> {
  await db.execute(sql`
    UPDATE users
    SET free_credits_state = 'ineligible'::free_credits_state,
        updated_at = now()
    WHERE id = ${dbUserId}::uuid
      AND free_credits_state = 'pending'::free_credits_state
    RETURNING id
  `);
}

async function reserveGrant(dbUserId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE users
    SET free_credits_state = 'devicecheck_updated'::free_credits_state,
        updated_at = now()
    WHERE id = ${dbUserId}::uuid
      AND free_credits_state = 'pending'::free_credits_state
    RETURNING id
  `);
  return Boolean(result.rows?.length);
}

async function writeGrant(
  dbUserId: string,
  transactionId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH granted AS (
      INSERT INTO credit_transactions (user_id, amount, type, reference_id)
      SELECT id, ${config.freeCreditBundle}, 'free_grant'::credit_transaction_type, ${transactionId}
      FROM users
      WHERE id = ${dbUserId}::uuid
        AND free_credits_state = 'devicecheck_updated'::free_credits_state
        AND NOT EXISTS (
          SELECT 1
          FROM credit_transactions
          WHERE user_id = ${dbUserId}::uuid
            AND type = 'free_grant'::credit_transaction_type
        )
      RETURNING user_id
    )
    UPDATE users
    SET credits_balance = credits_balance + ${config.freeCreditBundle},
        free_credits_state = 'granted'::free_credits_state,
        updated_at = now()
    WHERE id IN (SELECT user_id FROM granted)
    RETURNING id
  `);
  return Boolean(result.rows?.length);
}

/**
 * Grants the one-time DeviceCheck-backed credit bundle.
 *
 * `devicecheck_updated` is a durable reservation for this user. It is persisted before the
 * Apple update so a crash at any later point can retry safely without treating a reinstall's
 * already-set bit as this user's interrupted grant. The ledger insert, balance increment, and
 * transition to `granted` happen in one SQL statement.
 */
export async function grantIfEligible(
  dbUserId: string,
  firebaseUid: string,
  deviceToken: string,
): Promise<void> {
  const state = await loadState(dbUserId);
  console.info(`[free-credit] user=${firebaseUid} state=${state}`);

  if (state === 'granted' || state === 'ineligible') {
    console.info(`[free-credit] user=${firebaseUid} terminal=${state}; skipping`);
    return;
  }

  const queryTransactionId = uuidv4();
  const bits = await queryDeviceCheckBit(deviceToken, queryTransactionId);

  if (state === 'pending' && bits.bit0) {
    await markIneligible(dbUserId);
    console.info(`[free-credit] user=${firebaseUid} pending -> ineligible`);
    return;
  }

  if (state === 'pending') {
    const reserved = await reserveGrant(dbUserId);
    if (!reserved) {
      console.info(`[free-credit] user=${firebaseUid} reservation raced; reloading state`);
      await grantIfEligible(dbUserId, firebaseUid, deviceToken);
      return;
    }
    console.info(`[free-credit] user=${firebaseUid} pending -> devicecheck_updated`);
  }

  let ledgerReferenceId = queryTransactionId;
  if (!bits.bit0) {
    const updateTransactionId = uuidv4();
    await updateDeviceCheckBit(deviceToken, updateTransactionId);
    ledgerReferenceId = updateTransactionId;
    console.info(`[free-credit] user=${firebaseUid} DeviceCheck bit0 updated`);
  }

  const granted = await writeGrant(dbUserId, ledgerReferenceId);
  console.info(
    granted
      ? `[free-credit] user=${firebaseUid} devicecheck_updated -> granted amount=${config.freeCreditBundle}`
      : `[free-credit] user=${firebaseUid} grant already completed by another request`,
  );
}
