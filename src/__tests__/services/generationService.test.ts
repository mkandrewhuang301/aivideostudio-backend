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
  computeDreamActorCost,
  computeUpscalerCost,
  computeImageUpscaleCost,
  computeCharacterReplaceCost,
  computeCharacterReplaceProCost,
  computeKlingMotionControlCost,
  computeFaceswapCost,
  computeHappyHorseCost,
  resolveHappyHorseDuration,
  SUPPORTED_IMAGE_UPSCALE_MODELS,
  SUPPORTED_CHARACTER_REPLACE_MODELS,
  SUPPORTED_FACESWAP_MODELS,
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
  classifyFailureReason,
  isTransientProviderError,
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

// ─── HappyHorse 1.1 cost + duration (cents rule, 3–15s bound) ─────────────────

describe('computeHappyHorseCost + resolveHappyHorseDuration', () => {
  it('computes exact cost at 720p: ceil(5 * 0.14 * 100) = 70', () => {
    expect(computeHappyHorseCost(5, '720p')).toBe(70);
  });

  it('computes exact cost at 1080p: ceil(5 * 0.18 * 100) = 90', () => {
    expect(computeHappyHorseCost(5, '1080p')).toBe(90);
  });

  it('falls back to the 720p rate for an unknown resolution', () => {
    expect(computeHappyHorseCost(5, '4k')).toBe(computeHappyHorseCost(5, '720p'));
  });

  it('accepts 3s (wider low bound than the shared 4s guard)', () => {
    expect(resolveHappyHorseDuration(3)).toBe(3);
  });

  it('returns 5 for "auto"', () => {
    expect(resolveHappyHorseDuration('auto')).toBe(5);
  });

  it('throws below 3 or above 15, and for non-integers', () => {
    expect(() => resolveHappyHorseDuration(2)).toThrow(/between 3 and 15/);
    expect(() => resolveHappyHorseDuration(16)).toThrow(/between 3 and 15/);
    expect(() => resolveHappyHorseDuration(4.5)).toThrow(/between 3 and 15/);
  });
});

// ─── computeCostCredits ───────────────────────────────────────────────────────

describe('computeCostCredits', () => {
  it('computes exact cost for 6s at 720p mini: ceil(6 * 0.09 * 100) = 54', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    expect(cost).toBe(54);
  });

  it('returns a positive integer for 480p (lower than 720p)', () => {
    const cost = computeCostCredits({ durationSeconds: 6, resolution: '480p', model: 'bytedance/seedance-2.0-mini' });
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' }));
  });
});

// ─── Cents-rule regression (D-21 / RESEARCH.md Pitfall 1) + recraft cost fn ───

describe('cents-rule cost functions (verified, not re-broken)', () => {
  it('computeDreamActorCost(1s) == 5 credits (ceil(1 * 0.05 * 100))', () => {
    expect(computeDreamActorCost(1)).toBe(5);
  });

  it('computeUpscalerCost stays on the cents scale (standard/720p/<=30fps for 1s == 1 credit)', () => {
    // rate = 3.443/1000 $/sec; ceil(1 * 0.003443 * 100) = ceil(0.3443) = 1
    expect(computeUpscalerCost(1, 'standard', '720p', 30)).toBe(1);
  });

  it('computeImageUpscaleCost (recraft) == 1 credit (ceil(0.006 * 100) = ceil(0.6))', () => {
    expect(computeImageUpscaleCost()).toBe(1);
  });

  it('SUPPORTED_IMAGE_UPSCALE_MODELS registers recraft-ai/recraft-crisp-upscale', () => {
    expect(SUPPORTED_IMAGE_UPSCALE_MODELS).toContain('recraft-ai/recraft-crisp-upscale');
  });

  it('computeCharacterReplaceCost(5s) == 25 credits (ceil(5 * 0.05 * 100)) — confirmed 720p rate, D-23', () => {
    expect(computeCharacterReplaceCost(5)).toBe(25);
  });

  it('computeCharacterReplaceCost(1s) == 5 credits — same rate as DreamActor (5/sec)', () => {
    expect(computeCharacterReplaceCost(1)).toBe(computeDreamActorCost(1));
  });

  it('SUPPORTED_CHARACTER_REPLACE_MODELS registers wan-video/wan-2.2-animate-replace', () => {
    expect(SUPPORTED_CHARACTER_REPLACE_MODELS).toContain('wan-video/wan-2.2-animate-replace');
  });

  it('computeCharacterReplaceProCost(5s) == Kling std (7/sec, NOT pro — the pipeline itself is "Pro") + Wan 2.7 flat (3) == 38 credits', () => {
    expect(computeCharacterReplaceProCost(5)).toBe(computeKlingMotionControlCost(5, 'std') + 3);
    expect(computeCharacterReplaceProCost(5)).toBe(38);
  });

  it('computeCharacterReplaceProCost always costs more than Standard tier at the same duration', () => {
    expect(computeCharacterReplaceProCost(30)).toBeGreaterThan(computeCharacterReplaceCost(30));
  });

  it('computeFaceswapCost() == 5 credits (gpt-image-2-medium tier) — flat per-run cost, no duration', () => {
    expect(computeFaceswapCost()).toBe(5);
  });

  it('SUPPORTED_FACESWAP_MODELS registers openai/gpt-image-2-medium (easel/advanced-face-swap removed — 404 on Replicate, 09.2-12)', () => {
    expect(SUPPORTED_FACESWAP_MODELS).toContain('openai/gpt-image-2-medium');
    expect(SUPPORTED_FACESWAP_MODELS).not.toContain('easel/advanced-face-swap');
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
    expect(sqlText).toMatch(/status IN \('pending', 'processing'\)/);
    expect(sqlText).toMatch(/RETURNING id/);
  });

  it('returns false when the guarded UPDATE affects 0 rows (already transitioned)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await markCompleted('gen-uuid', 'generations/gen-uuid.mp4');

    expect(result).toBe(false);
  });
});

// ─── classifyFailureReason ─────────────────────────────────────────────────────

describe('classifyFailureReason', () => {
  it('classifies copyright errors from bytedance/seedance-2.0-mini', () => {
    const msg =
      'Prediction failed: Async prediction failed: Exception: The request failed because the output video may be related to copyright restrictions. Request id: 021782...';
    expect(classifyFailureReason(msg)).toBe('copyright');
  });

  it('classifies generic content-policy errors', () => {
    expect(classifyFailureReason('This prompt was flagged as NSFW')).toBe('content_policy');
  });

  it('classifies the Seedance E005 "flagged as sensitive" catch-all as content_policy (real-face/IP/NSFW block, prod string 2026-07-08)', () => {
    const msg =
      'Prediction failed: Async prediction failed: ModelError: The input or output was flagged as sensitive. Please try again with different inputs. (E005) (uIJ6l3ruRD)';
    expect(classifyFailureReason(msg)).toBe('content_policy');
    // regression guard: the bare code alone must still classify
    expect(classifyFailureReason('ModelError ... (E005)')).toBe('content_policy');
  });

  it('classifies celebrity/likeness errors as copyright', () => {
    expect(classifyFailureReason('The request was blocked: prompt references a famous celebrity')).toBe('copyright');
    expect(classifyFailureReason('Cannot generate a real public figure likeness')).toBe('copyright');
  });

  it('falls back to generic_error for unrecognized or missing errors', () => {
    expect(classifyFailureReason('Internal server error')).toBe('generic_error');
    expect(classifyFailureReason(undefined)).toBe('generic_error');
  });
});

// ─── isTransientProviderError ──────────────────────────────────────────────────

describe('isTransientProviderError', () => {
  it('classifies the prod ReadError string as transient', () => {
    expect(isTransientProviderError('Prediction failed: Async prediction failed: ReadError:')).toBe(true);
  });

  it('does not classify a copyright error as transient', () => {
    const msg =
      'Prediction failed: Async prediction failed: Exception: The request failed because the output video may be related to copyright restrictions.';
    expect(isTransientProviderError(msg)).toBe(false);
  });

  it('returns false for non-string or missing errors', () => {
    expect(isTransientProviderError(undefined)).toBe(false);
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
  it('returns true when the guarded UPDATE affects 1 row', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const result = await markQuarantined('gen-uuid');

    expect(result).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status IN \('pending', 'processing'\)/);
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
    // videoIn 720p mini: ceil(6 * 0.11 * 100) = ceil(66) = 66 credits
    expect(withVideo).toBe(66);
  });

  it('mini costs less than 2.0 standard', () => {
    const miniCost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    const standardCost = computeCostCredits({ durationSeconds: 6, resolution: '720p', model: 'bytedance/seedance-2.0' });
    expect(miniCost).toBeLessThan(standardCost);
    // mini 720p nonVideoIn: ceil(6 * 0.09 * 100) = 54 credits
    expect(miniCost).toBe(54);
  });

  it('applies ceiling to fractional credit costs (never underbills)', () => {
    // mini 5s * 0.09 * 100 = 45 → ceil = 45
    const cost = computeCostCredits({ durationSeconds: 5, resolution: '720p', model: 'bytedance/seedance-2.0-mini' });
    expect(cost).toBe(45);
  });

  it('applies 480p half-rate for mini videoIn', () => {
    const cost = computeCostCredits({
      durationSeconds: 4,
      resolution: '480p',
      model: 'bytedance/seedance-2.0-mini',
      hasVideoReference: true,
    });
    // mini 480p videoIn: ceil(4 * 0.05 * 100) = ceil(20) = 20
    expect(cost).toBe(20);
  });
});
