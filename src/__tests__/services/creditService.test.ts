// src/__tests__/services/creditService.test.ts
// Unit tests for creditService — PAY-03 (atomic deduction), getUserWithBalance, grantCredits, clawbackCredits
// All DB calls are mocked: no live Neon connection required.

// Mock the DB module
jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

import { db } from '../../db/client';
import {
  deductCredits,
  grantCredits,
  clawbackCredits,
  getUserWithBalance,
  refundCredits,
} from '../../services/creditService';

const mockDb = db as jest.Mocked<typeof db>;

// Extract SQL string from a Drizzle sql`` tagged template object
function extractSql(drizzleQuery: unknown): string {
  if (typeof drizzleQuery === 'string') return drizzleQuery;
  const q = drizzleQuery as { queryChunks?: Array<{ value?: string[] } | unknown> };
  if (q.queryChunks) {
    return q.queryChunks
      .map((chunk) => {
        if (chunk && typeof chunk === 'object' && 'value' in chunk) {
          const c = chunk as { value: string[] };
          return Array.isArray(c.value) ? c.value.join('') : '';
        }
        return ''; // scalar param — not SQL text
      })
      .join('');
  }
  return String(drizzleQuery);
}

// Helper to reset mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
  // Re-setup default insert mock after clearAllMocks
  (mockDb.insert as jest.Mock).mockReturnValue({
    values: jest.fn().mockResolvedValue(undefined),
  });
});

// ─── deductCredits ────────────────────────────────────────────────────────────

describe('deductCredits', () => {
  it('returns true and inserts ledger row when balance >= cost (1 row affected)', async () => {
    // Simulate UPDATE returning 1 row (sufficient balance)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'user-uuid' }] });

    const result = await deductCredits('user-uuid', 50);

    expect(result).toBe(true);
    // Verify atomic UPDATE was called with correct WHERE clause
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/credits_balance >= /);
    // Verify ledger row was inserted
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('returns false and writes NO ledger row when balance < cost (0 rows affected)', async () => {
    // Simulate UPDATE affecting 0 rows (insufficient balance)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await deductCredits('user-uuid', 999);

    expect(result).toBe(false);
    // No ledger row should be inserted on failure
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns false when rows is undefined (defensive — some DB drivers omit rows on 0 affected)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: undefined });

    const result = await deductCredits('user-uuid', 100);

    expect(result).toBe(false);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

// ─── grantCredits ─────────────────────────────────────────────────────────────

describe('grantCredits', () => {
  it('calls UPDATE and inserts ledger row for subscription_grant', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] }); // UPDATE result

    await grantCredits('user-uuid', 500, 'subscription_grant', 'txn-001');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    // subscription_grant must also reset subscription_allotment
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/subscription_allotment/);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('calls UPDATE and inserts ledger row for topup_grant (no subscription_allotment reset)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await grantCredits('user-uuid', 200, 'topup_grant', 'txn-002', new Date());

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    // topup_grant should NOT reset subscription_allotment
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).not.toMatch(/subscription_allotment/);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
});

// ─── clawbackCredits ─────────────────────────────────────────────────────────

describe('clawbackCredits', () => {
  it('updates balance with GREATEST(0, ...) clamp and inserts refund_clawback row', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await clawbackCredits('user-uuid', 100, 'txn-refund-001');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/GREATEST/);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
});

// ─── refundCredits ────────────────────────────────────────────────────────────

describe('refundCredits', () => {
  it('issues an UPDATE crediting the balance and inserts a generation_refund ledger row', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await refundCredits('user-uuid', 45, 'gen-uuid-123');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/credits_balance \+/);

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const insertMock = (mockDb.insert as jest.Mock).mock.results[0].value.values as jest.Mock;
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-uuid',
      amount: 45,
      type: 'generation_refund',
      reference_id: 'gen-uuid-123',
    });
  });
});

// ─── getUserWithBalance ───────────────────────────────────────────────────────

describe('getUserWithBalance', () => {
  it('returns balance data with active_topup_balance computed from unexpired topup rows', async () => {
    // 1st execute: expired topups check (returns none)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    // 2nd execute: user row SELECT
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ credits_balance: 300, subscription_allotment: 500, entitlement_level: 'basic' }],
    });
    // 3rd execute: active topup SUM
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ active_topup_balance: '150' }],
    });

    const result = await getUserWithBalance('user-uuid');

    expect(result).toEqual({
      credits_balance: 300,
      subscription_allotment: 500,
      active_topup_balance: 150,
      entitlement_level: 'basic',
    });
  });

  it('expires stale topup_grant rows before returning balance', async () => {
    // 1st execute: expired topups — returns 1 stale row
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: 'topup-tx-uuid', amount: 200, reference_id: 'rc-txn-001' }],
    });
    // 2nd execute: clawback UPDATE for expired topup
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    // 3rd execute: user row SELECT
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ credits_balance: 50, subscription_allotment: 100, entitlement_level: null }],
    });
    // 4th execute: active topup SUM (should be 0 now that topup is expired)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ active_topup_balance: '0' }],
    });

    const result = await getUserWithBalance('user-uuid');

    // Verify the expired topup clawback INSERT was called
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(result.active_topup_balance).toBe(0);
    expect(result.credits_balance).toBe(50);
  });

  it('throws if user not found', async () => {
    // 1st execute: expired topups (none)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    // 2nd execute: user row SELECT (empty — user not found)
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(getUserWithBalance('nonexistent-uuid')).rejects.toThrow('not found');
  });

  it('handles active_topup_balance of null/0 gracefully', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] }); // no expired topups
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ credits_balance: 100, subscription_allotment: 0, entitlement_level: null }],
    });
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{ active_topup_balance: null }], // NULL from COALESCE if no rows
    });

    const result = await getUserWithBalance('user-uuid');

    expect(result.active_topup_balance).toBe(0);
  });
});
