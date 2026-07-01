// src/__tests__/services/generationService.test.ts
// Unit tests for generationService — duration resolution, cost calc, atomic status transitions.
// All DB calls are mocked: no live Neon connection required.

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
  },
}));

import { db } from '../../db/client';
import {
  resolveDurationSeconds,
  computeCostCredits,
  markCompleted,
  markFailed,
  markRefunded,
  markQuarantined,
  attachPredictionId,
  getGenerationByPredictionId,
  createGeneration,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
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

function makeSelectChain(rows: unknown[] = []) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();

  // Re-setup select chain after clearAllMocks
  (mockDb.select as jest.Mock).mockReturnValue(makeSelectChain([]));

  // Re-setup insert chain after clearAllMocks
  (mockDb.insert as jest.Mock).mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'gen-default-id' }]),
    }),
  });
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
  it('computes exact cost for 6s at 720p mini: ceil(6 * 0.09 * 50) = 27', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    expect(cost).toBe(27);
  });

  it('returns a positive integer for 480p (lower than 720p)', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '480p', model: 'bytedance/seedance-2.0-mini' });
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' }));
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

// ─── markQuarantined ──────────────────────────────────────────────────────────

describe('markQuarantined', () => {
  it('returns true when the guarded UPDATE (WHERE status = processing) affects 1 row', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const result = await markQuarantined('gen-uuid');

    expect(result).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status = 'processing'/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('returns false when 0 rows affected (already transitioned — idempotent)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await markQuarantined('gen-uuid');

    expect(result).toBe(false);
  });
});

// ─── attachPredictionId ───────────────────────────────────────────────────────

describe('attachPredictionId', () => {
  it('executes UPDATE setting replicate_prediction_id and transitioning status to processing', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await attachPredictionId('gen-uuid', 'pred-abc');

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/replicate_prediction_id/);
    expect(sqlText).toMatch(/processing/);
    // Guard: only transitions from pending
    expect(sqlText).toMatch(/'pending'/);
  });
});

// ─── getGenerationByPredictionId ──────────────────────────────────────────────

describe('getGenerationByPredictionId', () => {
  it('returns the generation row when found', async () => {
    const mockRow = { id: 'gen-1', user_id: 'user-1', status: 'processing', cost_credits: 45 };
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [mockRow] });

    const result = await getGenerationByPredictionId('pred-abc');

    expect(result).toEqual(mockRow);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/replicate_prediction_id/);
  });

  it('returns undefined when no row matches the prediction id', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await getGenerationByPredictionId('pred-unknown');

    expect(result).toBeUndefined();
  });
});

// ─── getGenerationById ────────────────────────────────────────────────────────

describe('getGenerationById', () => {
  it('returns the generation row when it belongs to the requesting user', async () => {
    const mockRow = { id: 'gen-1', user_id: 'user-1', status: 'completed' };
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [mockRow] });

    const result = await getGenerationById('gen-1', 'user-1');

    expect(result).toEqual(mockRow);
    // IDOR guard: user_id must appear in the WHERE clause
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/user_id/);
    expect(sqlText).toMatch(/status NOT IN/);
  });

  it('returns undefined when generation belongs to a different user (IDOR guard)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await getGenerationById('gen-1', 'other-user');

    expect(result).toBeUndefined();
  });

  it('excludes quarantined and deleted rows from results', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await getGenerationById('gen-1', 'user-1');

    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/quarantined/);
    expect(sqlText).toMatch(/deleted/);
  });
});

// ─── softDeleteGeneration ─────────────────────────────────────────────────────

describe('softDeleteGeneration', () => {
  it('returns true when the guarded UPDATE marks the generation deleted (user owns it)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-1' }] });

    const result = await softDeleteGeneration('gen-1', 'user-1');

    expect(result).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status = 'deleted'/);
    expect(sqlText).toMatch(/user_id/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('returns false when 0 rows affected (generation belongs to another user — IDOR guard)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await softDeleteGeneration('gen-1', 'other-user');

    expect(result).toBe(false);
  });

  it('excludes already-deleted and quarantined rows from the guard (idempotent re-delete blocked)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await softDeleteGeneration('gen-1', 'user-1');

    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status NOT IN/);
    expect(sqlText).toMatch(/deleted/);
    expect(sqlText).toMatch(/quarantined/);
  });
});

// ─── createGeneration ─────────────────────────────────────────────────────────

describe('createGeneration', () => {
  it('inserts a row and returns the generated id from the RETURNING clause', async () => {
    (mockDb.insert as jest.Mock).mockReturnValueOnce({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 'gen-new-uuid' }]),
      }),
    });

    const result = await createGeneration({
      user_id: 'user-1',
      model: 'bytedance/seedance-2.0-fast',
      status: 'pending',
      prompt: 'a cinematic city at night',
      params: { resolution: '720p', duration: 8, aspect_ratio: '16:9', audio_enabled: false, has_reference: false, ref_upload_ids: [] },
      cost_credits: 60,
    } as Parameters<typeof createGeneration>[0]);

    expect(result).toEqual({ id: 'gen-new-uuid' });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
});

// ─── listGenerations ──────────────────────────────────────────────────────────

describe('listGenerations', () => {
  it('executes a Drizzle select and returns rows matching the user', async () => {
    const mockRows = [
      { id: 'gen-1', user_id: 'user-1', status: 'completed' },
      { id: 'gen-2', user_id: 'user-1', status: 'pending' },
    ];
    const chain = makeSelectChain(mockRows);
    (mockDb.select as jest.Mock).mockReturnValueOnce(chain);

    const result = await listGenerations('user-1');

    expect(result).toEqual(mockRows);
    expect(mockDb.select).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(20); // default limit
  });

  it('passes custom limit to the query', async () => {
    const chain = makeSelectChain([]);
    (mockDb.select as jest.Mock).mockReturnValueOnce(chain);

    await listGenerations('user-1', undefined, 10);

    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it('returns empty array when no generations exist for the user', async () => {
    const chain = makeSelectChain([]);
    (mockDb.select as jest.Mock).mockReturnValueOnce(chain);

    const result = await listGenerations('user-with-no-generations');

    expect(result).toEqual([]);
  });
});

// ─── computeCostCredits extended ──────────────────────────────────────────────

describe('computeCostCredits — extended', () => {
  it('applies videoIn rate when hasVideoReference=true (higher than nonVideoIn)', () => {
    const withVideo = computeCostCredits({
      durationSeconds: 6,
      resolution: '720p',
      model: 'bytedance/seedance-2.0-mini',
      hasVideoReference: true,
    });
    const withoutVideo = computeCostCredits({
      durationSeconds: 6,
      resolution: '720p',
      model: 'bytedance/seedance-2.0-mini',
      hasVideoReference: false,
    });
    expect(withVideo).toBeGreaterThan(withoutVideo);
    // videoIn 720p mini: ceil(6 * 0.11 * 50) = ceil(33) = 33 credits
    expect(withVideo).toBe(33);
  });

  it('mini costs less than 2.0 standard', () => {
    const miniCost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    const standardCost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0' });
    expect(miniCost).toBeLessThan(standardCost);
    // mini 720p nonVideoIn: ceil(6 * 0.09 * 50) = 27 credits
    expect(miniCost).toBe(27);
  });

  it('applies ceiling to fractional credit costs (never underbills)', () => {
    // mini 5s * 0.09 * 50 = 22.5 → ceil = 23
    const cost = computeCostCredits({ durationSeconds: 5, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    expect(cost).toBe(23);
  });

  it('applies 480p half-rate for mini videoIn', () => {
    const cost = computeCostCredits({
      durationSeconds: 4,
      resolution: '480p',
      model: 'bytedance/seedance-2.0-mini',
      hasVideoReference: true,
    });
    // mini 480p videoIn: ceil(4 * 0.05 * 50) = ceil(10) = 10
    expect(cost).toBe(10);
  });
});
