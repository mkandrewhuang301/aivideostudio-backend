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
  // Perf: the balance UPDATE and the ledger INSERT are now one data-modifying-CTE statement
  // (single db.execute, no separate db.insert call) — also fixes a prior non-atomicity gap
  // between the two writes.

  it('returns true when balance >= cost (1 row affected by the CTE)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ user_id: 'user-uuid' }] });

    const result = await deductCredits('user-uuid', 50);

    expect(result).toBe(true);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    // Verify atomic UPDATE + ledger INSERT are both in the single statement
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/credits_balance >= /);
    expect(sqlText).toMatch(/INSERT INTO credit_transactions/);
    expect(sqlText).toMatch(/generation_deduct/);
    // No separate db.insert call — it's part of the same statement
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns false when balance < cost (0 rows affected, no ledger row written)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await deductCredits('user-uuid', 999);

    expect(result).toBe(false);
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
  // Perf: this is now 1 combined query (credits_balance + subscription_allotment +
  // entitlement_level + active_topup_balance + expired_topups in one round trip) in the
  // common case — only expired top-ups trigger the clawback loop + a second combined query.

  it('returns balance data in a single query when there are no expired top-ups', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 300,
        subscription_allotment: 500,
        entitlement_level: 'basic',
        active_topup_balance: '150',
        expired_topups: [],
      }],
    });

    const result = await getUserWithBalance('user-uuid');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      credits_balance: 300,
      subscription_allotment: 500,
      active_topup_balance: 150,
      entitlement_level: 'basic',
    });
  });

  it('includes merged source ledgers when calculating top-up balance and expiry', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 300,
        subscription_allotment: 0,
        entitlement_level: 'basic',
        active_topup_balance: '200',
        expired_topups: [],
      }],
    });

    await getUserWithBalance('user-uuid');

    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/effective_ledger_users/);
    expect(sqlText).toMatch(/FROM user_merges/);
    expect(sqlText).toMatch(/from_user_id/);
    expect(sqlText).toMatch(/to_user_id/);
  });

  it('expires stale topup_grant rows, then re-fetches once before returning balance', async () => {
    // 1st execute: combined query — one expired topup present
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 250,
        subscription_allotment: 100,
        entitlement_level: null,
        active_topup_balance: '0',
        expired_topups: [{ id: 'topup-tx-uuid', amount: 200 }],
      }],
    });
    // 2nd execute: clawback UPDATE for the expired topup
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    // 3rd execute: re-fetched combined query after clawback
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 50,
        subscription_allotment: 100,
        entitlement_level: null,
        active_topup_balance: '0',
        expired_topups: [],
      }],
    });

    const result = await getUserWithBalance('user-uuid');

    expect(mockDb.execute).toHaveBeenCalledTimes(3);
    // Verify the expired topup clawback INSERT was called
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(result.active_topup_balance).toBe(0);
    expect(result.credits_balance).toBe(50);
  });

  it('throws if user not found', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(getUserWithBalance('nonexistent-uuid')).rejects.toThrow('not found');
  });

  it('handles active_topup_balance of null/0 gracefully', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 100,
        subscription_allotment: 0,
        entitlement_level: null,
        active_topup_balance: null, // NULL from COALESCE if no rows
        expired_topups: [],
      }],
    });

    const result = await getUserWithBalance('user-uuid');

    expect(result.active_topup_balance).toBe(0);
  });

  it('handles expired_topups returned as a JSON string (some drivers do not auto-parse)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 250,
        subscription_allotment: 100,
        entitlement_level: null,
        active_topup_balance: '0',
        expired_topups: JSON.stringify([{ id: 'topup-tx-uuid', amount: 200 }]),
      }],
    });
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({
      rows: [{
        credits_balance: 50,
        subscription_allotment: 100,
        entitlement_level: null,
        active_topup_balance: '0',
        expired_topups: '[]',
      }],
    });

    const result = await getUserWithBalance('user-uuid');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(result.credits_balance).toBe(50);
  });
});
