import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { getFirebaseAdmin } from '../firebase';
import { canonicalGmailAddress } from './gmailAlias';

const EXECUTE_CONFIRMATION = 'CONSOLIDATE_GMAIL_ALIAS';

interface ExpectedSnapshot {
  sourceBalance: number;
  targetBalance: number;
  transferableCredits: number;
  sourceGenerations: number;
  targetGenerations: number;
  sourceProjects: number;
  targetProjects: number;
  sourceUploads: number;
  targetUploads: number;
}

interface AccountSnapshotRow {
  id: string;
  firebase_uid: string;
  credits_balance: number;
  total_generations: number;
  banned: boolean;
  generations: number;
  projects: number;
  uploads: number;
  non_free_ledger_sum: number;
  prior_merge_count: number;
}

interface ConsolidationResultRow {
  merge_id: string;
  transferred_credits: number;
  excluded_credits: number;
  moved_generations: number;
  moved_projects: number;
  moved_uploads: number;
  target_balance: number;
  source_balance: number;
}

function parseNamedArgs(argv: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith('--') || !argument.includes('=')) continue;
    const separator = argument.indexOf('=');
    result.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return result;
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key)?.trim();
  if (!value) throw new Error(`Missing required --${key}=... argument`);
  return value;
}

function requiredInteger(args: Map<string, string>, key: string): number {
  const raw = required(args, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }
  return value;
}

function assertEqual(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Preflight mismatch for ${label}: expected ${expected}, found ${actual}`);
  }
}

async function loadSnapshot(firebaseUid: string): Promise<AccountSnapshotRow> {
  const result = await db.execute(sql`
    SELECT
      account.id,
      account.firebase_uid,
      account.credits_balance,
      account.total_generations,
      account.banned,
      (SELECT COUNT(*)::integer FROM generations item WHERE item.user_id = account.id) AS generations,
      (SELECT COUNT(*)::integer FROM projects item WHERE item.user_id = account.id) AS projects,
      (SELECT COUNT(*)::integer FROM reference_uploads item WHERE item.user_id = account.id) AS uploads,
      (SELECT COALESCE(SUM(amount) FILTER (WHERE type <> 'free_grant'), 0)::integer
         FROM credit_transactions item WHERE item.user_id = account.id) AS non_free_ledger_sum,
      (SELECT COUNT(*)::integer FROM user_merges item WHERE item.from_user_id = account.id) AS prior_merge_count
    FROM users account
    WHERE account.firebase_uid = ${firebaseUid}
    LIMIT 1
  `);
  const row = result.rows?.[0] as unknown as AccountSnapshotRow | undefined;
  if (!row) throw new Error(`Backend user ${firebaseUid.slice(0, 8)}… was not found`);
  return row;
}

function validateSnapshot(
  source: AccountSnapshotRow,
  target: AccountSnapshotRow,
  expected: ExpectedSnapshot,
): void {
  if (source.id === target.id) throw new Error('Source and target resolve to the same backend user');
  if (source.banned || target.banned) throw new Error('Source or target is already banned');
  if (source.prior_merge_count !== 0) throw new Error('Source already has a user_merges audit row');

  assertEqual('source balance', source.credits_balance, expected.sourceBalance);
  assertEqual('target balance', target.credits_balance, expected.targetBalance);
  assertEqual('source generations', source.generations, expected.sourceGenerations);
  assertEqual('target generations', target.generations, expected.targetGenerations);
  assertEqual('source projects', source.projects, expected.sourceProjects);
  assertEqual('target projects', target.projects, expected.targetProjects);
  assertEqual('source uploads', source.uploads, expected.sourceUploads);
  assertEqual('target uploads', target.uploads, expected.targetUploads);
  assertEqual('source non-free ledger sum', source.non_free_ledger_sum, expected.transferableCredits);

  if (expected.transferableCredits > source.credits_balance) {
    throw new Error('Transferable ledger credits exceed the source balance');
  }
}

async function consolidate(
  source: AccountSnapshotRow,
  target: AccountSnapshotRow,
  transferableCredits: number,
): Promise<ConsolidationResultRow> {
  const mergeId = randomUUID();
  const excludedCredits = source.credits_balance - transferableCredits;
  const result = await db.execute(sql`
    WITH record_merge AS (
      INSERT INTO user_merges (
        id, from_user_id, to_user_id, transferred_credits, excluded_free_credits, created_at
      ) VALUES (
        ${mergeId}::uuid,
        ${source.id}::uuid,
        ${target.id}::uuid,
        ${transferableCredits},
        ${excludedCredits},
        now()
      )
      ON CONFLICT (from_user_id) DO NOTHING
      RETURNING id, from_user_id, to_user_id, transferred_credits, excluded_free_credits
    ),
    record_transfer AS (
      INSERT INTO credit_transactions (user_id, amount, type, reference_id, created_at)
      SELECT from_user_id, -transferred_credits, 'merge_transfer'::credit_transaction_type, id::text, now()
      FROM record_merge WHERE transferred_credits > 0
      UNION ALL
      SELECT to_user_id, transferred_credits, 'merge_transfer'::credit_transaction_type, id::text, now()
      FROM record_merge WHERE transferred_credits > 0
      RETURNING id
    ),
    move_generations AS (
      UPDATE generations item SET user_id = merge.to_user_id
      FROM record_merge merge WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    move_uploads AS (
      UPDATE reference_uploads item SET user_id = merge.to_user_id
      FROM record_merge merge WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    move_projects AS (
      UPDATE projects item SET user_id = merge.to_user_id, updated_at = now()
      FROM record_merge merge WHERE item.user_id = merge.from_user_id
      RETURNING item.id
    ),
    update_target AS (
      UPDATE users destination
      SET credits_balance = destination.credits_balance + merge.transferred_credits,
          entitlement_level = COALESCE(destination.entitlement_level, origin.entitlement_level),
          subscription_product_id = COALESCE(destination.subscription_product_id, origin.subscription_product_id),
          subscription_started_at = COALESCE(destination.subscription_started_at, origin.subscription_started_at),
          subscription_allotment = GREATEST(destination.subscription_allotment, origin.subscription_allotment),
          total_generations = destination.total_generations + origin.total_generations,
          moderation_strikes = GREATEST(destination.moderation_strikes, origin.moderation_strikes),
          updated_at = now()
      FROM record_merge merge, users origin
      WHERE destination.id = merge.to_user_id AND origin.id = merge.from_user_id
      RETURNING destination.credits_balance
    ),
    tombstone_source AS (
      UPDATE users origin
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
      FROM record_merge merge
      WHERE origin.id = merge.from_user_id
      RETURNING origin.credits_balance
    )
    SELECT
      merge.id AS merge_id,
      merge.transferred_credits,
      merge.excluded_free_credits AS excluded_credits,
      (SELECT COUNT(*)::integer FROM move_generations) AS moved_generations,
      (SELECT COUNT(*)::integer FROM move_projects) AS moved_projects,
      (SELECT COUNT(*)::integer FROM move_uploads) AS moved_uploads,
      (SELECT credits_balance FROM update_target) AS target_balance,
      (SELECT credits_balance FROM tombstone_source) AS source_balance
    FROM record_merge merge
  `);
  const row = result.rows?.[0] as unknown as ConsolidationResultRow | undefined;
  if (!row) throw new Error('Consolidation did not produce an audit row; no changes were accepted');
  return row;
}

async function main(): Promise<void> {
  const args = parseNamedArgs(process.argv.slice(2));
  const sourceEmail = required(args, 'source-email').toLowerCase();
  const targetEmail = required(args, 'target-email').toLowerCase();
  const expected: ExpectedSnapshot = {
    sourceBalance: requiredInteger(args, 'expected-source-balance'),
    targetBalance: requiredInteger(args, 'expected-target-balance'),
    transferableCredits: requiredInteger(args, 'expected-transferable-credits'),
    sourceGenerations: requiredInteger(args, 'expected-source-generations'),
    targetGenerations: requiredInteger(args, 'expected-target-generations'),
    sourceProjects: requiredInteger(args, 'expected-source-projects'),
    targetProjects: requiredInteger(args, 'expected-target-projects'),
    sourceUploads: requiredInteger(args, 'expected-source-uploads'),
    targetUploads: requiredInteger(args, 'expected-target-uploads'),
  };
  const execute = args.get('execute') === EXECUTE_CONFIRMATION;

  const sourceCanonical = canonicalGmailAddress(sourceEmail);
  const targetCanonical = canonicalGmailAddress(targetEmail);
  if (!sourceCanonical || !targetCanonical || sourceCanonical !== targetCanonical) {
    throw new Error('Source and target must be Gmail/Googlemail dot aliases of the same mailbox');
  }
  if (sourceEmail === targetEmail) throw new Error('Source and target email strings must differ');

  const auth = getFirebaseAdmin().auth;
  const [sourceFirebase, targetFirebase] = await Promise.all([
    auth.getUserByEmail(sourceEmail),
    auth.getUserByEmail(targetEmail),
  ]);
  if (sourceFirebase.uid === targetFirebase.uid) throw new Error('Firebase source and target are identical');
  if (!sourceFirebase.emailVerified || !targetFirebase.emailVerified) {
    throw new Error('Both Firebase email addresses must already be verified');
  }
  if (!sourceFirebase.providerData.some((provider) => provider.providerId === 'password')) {
    throw new Error('Source must be the legacy password account');
  }
  if (!targetFirebase.providerData.some((provider) => provider.providerId === 'google.com')) {
    throw new Error('Target must be the surviving Google account');
  }

  const [source, target] = await Promise.all([
    loadSnapshot(sourceFirebase.uid),
    loadSnapshot(targetFirebase.uid),
  ]);
  validateSnapshot(source, target, expected);

  const excludedCredits = source.credits_balance - expected.transferableCredits;
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    source: {
      uidPrefix: `${source.firebase_uid.slice(0, 8)}…`,
      balance: source.credits_balance,
      generations: source.generations,
      projects: source.projects,
      uploads: source.uploads,
      nonFreeLedgerCredits: source.non_free_ledger_sum,
    },
    target: {
      uidPrefix: `${target.firebase_uid.slice(0, 8)}…`,
      balance: target.credits_balance,
      generations: target.generations,
      projects: target.projects,
      uploads: target.uploads,
    },
    proposed: {
      transferableCredits: expected.transferableCredits,
      excludedCredits,
      finalTargetBalance: target.credits_balance + expected.transferableCredits,
    },
  }, null, 2));

  if (!execute) {
    console.log(`Dry run only. Re-run with --execute=${EXECUTE_CONFIRMATION} after reviewing this snapshot.`);
    return;
  }

  const result = await consolidate(source, target, expected.transferableCredits);
  assertEqual('moved generations', result.moved_generations, expected.sourceGenerations);
  assertEqual('moved projects', result.moved_projects, expected.sourceProjects);
  assertEqual('moved uploads', result.moved_uploads, expected.sourceUploads);
  assertEqual('final target balance', result.target_balance, expected.targetBalance + expected.transferableCredits);
  assertEqual('tombstone balance', result.source_balance, excludedCredits);

  try {
    await auth.deleteUser(sourceFirebase.uid);
  } catch (error) {
    console.error('CRITICAL: database consolidation committed but Firebase source deletion failed:', error);
    process.exitCode = 2;
    return;
  }

  const [sourceAfter, targetAfter] = await Promise.all([
    loadSnapshot(sourceFirebase.uid),
    loadSnapshot(targetFirebase.uid),
  ]);
  console.log(JSON.stringify({
    status: 'consolidated',
    mergeId: result.merge_id,
    source: {
      uidPrefix: `${sourceAfter.firebase_uid.slice(0, 8)}…`,
      banned: sourceAfter.banned,
      balance: sourceAfter.credits_balance,
      generations: sourceAfter.generations,
      projects: sourceAfter.projects,
      uploads: sourceAfter.uploads,
    },
    target: {
      uidPrefix: `${targetAfter.firebase_uid.slice(0, 8)}…`,
      balance: targetAfter.credits_balance,
      generations: targetAfter.generations,
      projects: targetAfter.projects,
      uploads: targetAfter.uploads,
    },
  }, null, 2));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
