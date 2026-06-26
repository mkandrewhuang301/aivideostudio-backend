// src/__tests__/services/generationService.test.ts
// Unit tests for generationService — duration resolution, cost calc, atomic status transitions.
// All DB calls are mocked: no live Neon connection required.

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
  },
}));

import { db } from '../../db/client';
import {
  resolveDurationSeconds,
  computeCostCredits,
  markCompleted,
  markFailed,
  markRefunded,
} from '../../services/generationService';

const mockDb = db as jest.Mocked<typeof db>;

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
        return '';
      })
      .join('');
  }
  return String(drizzleQuery);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── resolveDurationSeconds ───────────────────────────────────────────────────

describe('resolveDurationSeconds', () => {
  it('returns the integer unchanged for valid durations within 4-15', () => {
    expect(resolveDurationSeconds(8)).toBe(8);
  });

  it('returns 5 (placeholder default) for "auto"', () => {
    expect(resolveDurationSeconds('auto')).toBe(5);
  });

  it('throws for durations below 4', () => {
    expect(() => resolveDurationSeconds(3)).toThrow(/between 4 and 15/);
  });

  it('throws for durations above 15', () => {
    expect(() => resolveDurationSeconds(16)).toThrow(/between 4 and 15/);
  });

  it('throws for non-integer durations', () => {
    expect(() => resolveDurationSeconds(7.5)).toThrow(/between 4 and 15/);
  });
});

// ─── computeCostCredits ───────────────────────────────────────────────────────

describe('computeCostCredits', () => {
  it('computes exact cost for 6s at 720p: ceil(6 * 0.15 * 50) = 45', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-fast' });
    expect(cost).toBe(45);
  });

  it('returns a positive integer for 480p (half rate)', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '480p', model: 'bytedance/seedance-2.0-fast' });
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-fast' }));
  });
});

// ─── markCompleted ────────────────────────────────────────────────────────────

describe('markCompleted', () => {
  it('returns true when the guarded UPDATE affects 1 row', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const result = await markCompleted('gen-uuid', 'generations/gen-uuid.mp4');

    expect(result).toBe(true);
    const executeCall = (mockDb.execute as jest.Mock).mock.calls[0][0];
    const sqlText = extractSql(executeCall);
    expect(sqlText).toMatch(/status = 'processing'/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('returns false when the guarded UPDATE affects 0 rows (already transitioned)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await markCompleted('gen-uuid', 'generations/gen-uuid.mp4');

    expect(result).toBe(false);
  });
});

// ─── markFailed / markRefunded ────────────────────────────────────────────────

describe('markFailed and markRefunded', () => {
  it('markFailed uses guarded UPDATE WHERE status IN (pending, processing)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const result = await markFailed('gen-uuid');

    expect(result).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status IN \('pending', 'processing'\)/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('markFailed returns false when 0 rows affected', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const result = await markFailed('gen-uuid');
    expect(result).toBe(false);
  });

  it('markRefunded uses the same guarded-UPDATE shape as markFailed', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const result = await markRefunded('gen-uuid');

    expect(result).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status IN \('pending', 'processing'\)/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('markRefunded returns false when 0 rows affected', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const result = await markRefunded('gen-uuid');
    expect(result).toBe(false);
  });
});
