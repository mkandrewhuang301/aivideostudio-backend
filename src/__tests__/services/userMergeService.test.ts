const mockExecute = jest.fn();

jest.mock('../../config', () => ({ config: {} }));

jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
  },
}));

const mockRandomUuid = jest.fn(() => '33333333-3333-4333-8333-333333333333');
jest.mock('node:crypto', () => ({ randomUUID: mockRandomUuid }));

const mockDeleteUser = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { deleteUser: mockDeleteUser } }),
}));

const mockEvictAuthCache = jest.fn();
jest.mock('../../middleware/auth', () => ({
  evictAuthCache: mockEvictAuthCache,
}));

import { MergeError, mergeUser } from '../../services/userMergeService';

const SOURCE_DB_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_DB_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_FIREBASE_UID = 'anonymous-firebase-uid';
const TARGET_FIREBASE_UID = 'existing-firebase-uid';

function sqlText(callIndex: number): string {
  return JSON.stringify(mockExecute.mock.calls[callIndex]?.[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [{
        target_firebase_uid: TARGET_FIREBASE_UID,
        transferred_credits: 20,
        excluded_free_credits: 3,
      }],
    });
  mockDeleteUser.mockResolvedValue(undefined);
});

describe('mergeUser', () => {
  it('moves purchased balance and owned resources in one atomic statement', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    expect(mockExecute).toHaveBeenCalledTimes(2);
    const mergeSql = sqlText(1);
    expect(mergeSql).toContain('UPDATE generations');
    expect(mergeSql).toContain('UPDATE reference_uploads');
    expect(mergeSql).toContain('UPDATE projects');
    expect(mergeSql).toContain('credits_balance');
    expect(mergeSql).toContain('subscription_product_id');
  });

  it('records paired append-only transfers without rewriting historical ledger rows', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    const mergeSql = sqlText(1);
    expect(mergeSql).toContain('INSERT INTO credit_transactions');
    expect(mergeSql).toContain('merge_transfer');
    expect(mergeSql).not.toContain('UPDATE credit_transactions');
    expect(mergeSql).not.toContain('DELETE FROM credit_transactions');
  });

  it('copies entitlements only when target fields are empty', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    expect(sqlText(1)).toContain('COALESCE');
    expect(sqlText(1)).toContain('GREATEST');
  });

  it('deletes the anonymous Firebase user after the atomic database statement', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    expect(mockDeleteUser).toHaveBeenCalledWith(SOURCE_FIREBASE_UID);
    expect(mockExecute.mock.invocationCallOrder[1]).toBeLessThan(mockDeleteUser.mock.invocationCallOrder[0]);
  });
});

describe('free-grant exclusion', () => {
  it('calculates remaining free credit from grants plus net generation activity', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    const mergeSql = sqlText(1);
    expect(mergeSql).toContain('free_grant');
    expect(mergeSql).toContain('generation_deduct');
    expect(mergeSql).toContain('generation_refund');
    expect(mergeSql).not.toContain('refund_clawback');
  });

  it('records transferred and excluded balances in user_merges', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    const mergeSql = sqlText(1);
    expect(mergeSql).toContain('INSERT INTO user_merges');
    expect(mergeSql).toContain('transferred_credits');
    expect(mergeSql).toContain('excluded_free_credits');
  });

  it('tombstones the source row and preserves it as the ledger anchor', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    const mergeSql = sqlText(1);
    expect(mergeSql).toContain('tombstone_source');
    expect(mergeSql).toContain('banned');
    expect(mergeSql).not.toContain('DELETE FROM users');
  });
});

describe('idempotency', () => {
  it('rejects an already-recorded source before running the transfer', async () => {
    mockExecute.mockReset().mockResolvedValueOnce({ rows: [{ exists: 1 }] });

    await expect(mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID)).rejects.toMatchObject({
      code: 'ALREADY_MERGED',
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('rejects attempts to merge an account into itself', async () => {
    await expect(mergeUser(SOURCE_DB_ID, SOURCE_DB_ID, SOURCE_FIREBASE_UID)).rejects.toBeInstanceOf(MergeError);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('treats an empty atomic result as a concurrent duplicate', async () => {
    mockExecute.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID)).rejects.toMatchObject({
      code: 'ALREADY_MERGED',
    });
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('evicts auth cache entries for both Firebase UIDs', async () => {
    await mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID);

    expect(mockEvictAuthCache).toHaveBeenNthCalledWith(1, SOURCE_FIREBASE_UID);
    expect(mockEvictAuthCache).toHaveBeenNthCalledWith(2, TARGET_FIREBASE_UID);
  });

  it('keeps the committed merge successful when Firebase deletion fails', async () => {
    mockDeleteUser.mockRejectedValueOnce(new Error('Firebase unavailable'));

    await expect(mergeUser(SOURCE_DB_ID, TARGET_DB_ID, SOURCE_FIREBASE_UID)).resolves.toBeUndefined();
    expect(mockEvictAuthCache).toHaveBeenCalledTimes(2);
  });
});
