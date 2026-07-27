// src/__tests__/services/audioSeparationService.test.ts
// Unit tests for audioSeparationService — quote math, ownership scoping, daily rate-limit,
// idempotent atomic-deduct create, status transitions, prior-volume-capture-before-mute,
// stem-attach partition, and single-shot refund. All DB/Redis calls are mocked: no live
// Neon/Redis connection required.
//
// NOTE (deviation from plan's stated file path `src/services/audioSeparationService.test.ts`):
// this repo's jest.config.ts testMatch is `**/__tests__/**/*.test.ts` — a test file living
// directly under src/services/ would never be discovered/run. Placed under
// src/__tests__/services/ instead, matching every other service test in this codebase
// (creditService.test.ts, generationService.test.ts, etc.). See SUMMARY.md Deviations.

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
    batch: jest.fn(),
  },
}));
jest.mock('../../redis/client', () => ({ redis: { incr: jest.fn(), expire: jest.fn() } }));
// Config is mocked (not loaded from real env vars) so this suite runs standalone without a
// DATABASE_URL/REDIS_URL/etc. environment — mirrors hiveScanWorker.test.ts's full config mock.
jest.mock('../../config', () => ({
  config: {
    audioSepEnabled: true,
    audioSepModel: 'fal-ai/sam-audio/separate',
    audioSepCreditsPerSecond: 0.167,
    audioSepWorkerConcurrency: 2,
    audioSepRequestsPerMinute: 8,
    audioSepDailyRateLimitPerUser: 50,
  },
}));

import { db } from '../../db/client';
import { redis } from '../../redis/client';
import { config } from '../../config';
import type { AudioSeparationJob } from '../../db/schema';
import {
  resolveClipDurationSeconds,
  verifyClipOwnership,
  quoteAudioSeparation,
  checkDailyRateLimit,
  createAudioSeparationJob,
  markAudioSeparationProcessing,
  completeAudioSeparation,
  attachSeparationStems,
  refundAudioSeparation,
  AudioSeparationNotFoundError,
  AudioSeparationValidationError,
  InsufficientSeparationCreditsError,
  SeparationRateLimitedError,
} from '../../services/audioSeparationService';

const mockDb = db as jest.Mocked<typeof db>;
const mockRedis = redis as unknown as { incr: jest.Mock; expire: jest.Mock };

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

// Ownership-select chain: db.select({...}).from(projectClips).innerJoin(projects, ...).where(...)
function makeOwnershipChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(rows);
  return chain;
}

// Plain select chain: db.select().from(table).where(...) — no join.
function makePlainSelectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(rows);
  return chain;
}

const OWNED_CLIP_ROW = {
  id: 'clip-1',
  project_id: 'project-1',
  volume: 1,
  trim_start_seconds: 0,
  trim_end_seconds: 10,
  original_duration_seconds: 10,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── resolveClipDurationSeconds ───────────────────────────────────────────────

describe('resolveClipDurationSeconds', () => {
  it('resolves from trim_start/trim_end when both present', () => {
    expect(resolveClipDurationSeconds({ trim_start_seconds: 2, trim_end_seconds: 12, original_duration_seconds: null })).toBe(10);
  });

  it('falls back to original_duration_seconds when trim_end_seconds is null', () => {
    expect(resolveClipDurationSeconds({ trim_start_seconds: 0, trim_end_seconds: null, original_duration_seconds: 20 })).toBe(20);
  });

  it('rounds to 3 decimals', () => {
    expect(resolveClipDurationSeconds({ trim_start_seconds: 0, trim_end_seconds: 26.6666, original_duration_seconds: null })).toBe(26.667);
  });

  it('throws AudioSeparationValidationError when duration is unresolvable (both null) — NEVER a placeholder', () => {
    expect(() => resolveClipDurationSeconds({ trim_start_seconds: 0, trim_end_seconds: null, original_duration_seconds: null }))
      .toThrow(AudioSeparationValidationError);
  });

  it('throws when resolved duration is zero or negative', () => {
    expect(() => resolveClipDurationSeconds({ trim_start_seconds: 5, trim_end_seconds: 5, original_duration_seconds: null }))
      .toThrow(AudioSeparationValidationError);
    expect(() => resolveClipDurationSeconds({ trim_start_seconds: 10, trim_end_seconds: 5, original_duration_seconds: null }))
      .toThrow(AudioSeparationValidationError);
  });
});

// ─── verifyClipOwnership ───────────────────────────────────────────────────────

describe('verifyClipOwnership', () => {
  it("throws AudioSeparationNotFoundError for a clip owned by another user (no existence leak)", async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([]));
    await expect(verifyClipOwnership('clip-1', 'user-attacker')).rejects.toThrow(AudioSeparationNotFoundError);
  });

  it('returns the clip row (including current volume) for an owned clip', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]));
    const result = await verifyClipOwnership('clip-1', 'user-1');
    expect(result).toEqual(OWNED_CLIP_ROW);
    expect(result.volume).toBe(1);
  });
});

// ─── quoteAudioSeparation ───────────────────────────────────────────────────────

describe('quoteAudioSeparation', () => {
  it.each([5, 10, 20, 30])(
    'quotes credits as max(1, ceil(duration * audioSepCreditsPerSecond)) for a %ds clip',
    async (durationSeconds) => {
      (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([{
        ...OWNED_CLIP_ROW, trim_start_seconds: 0, trim_end_seconds: durationSeconds, original_duration_seconds: durationSeconds,
      }]));

      const quote = await quoteAudioSeparation('clip-1', 'user-1');

      expect(quote.supported).toBe(true);
      expect(quote.duration_seconds).toBe(durationSeconds);
      expect(quote.cost_credits).toBe(Math.max(1, Math.ceil(durationSeconds * config.audioSepCreditsPerSecond)));
      expect(quote.cost_credits).toBeGreaterThanOrEqual(1);
    },
  );

  it('rejects a clip with no resolvable duration before any credit math', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([{
      ...OWNED_CLIP_ROW, trim_end_seconds: null, original_duration_seconds: null,
    }]));
    await expect(quoteAudioSeparation('clip-1', 'user-1')).rejects.toThrow(AudioSeparationValidationError);
  });

  it('propagates ownership rejection for a foreign clip', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([]));
    await expect(quoteAudioSeparation('clip-1', 'user-attacker')).rejects.toThrow(AudioSeparationNotFoundError);
  });
});

// ─── checkDailyRateLimit ────────────────────────────────────────────────────────

describe('checkDailyRateLimit', () => {
  it('allows the Nth call (at the configured cap)', async () => {
    mockRedis.incr.mockResolvedValueOnce(config.audioSepDailyRateLimitPerUser);
    await expect(checkDailyRateLimit('user-1')).resolves.toBeUndefined();
  });

  it('rejects the (cap + 1)th call in a day', async () => {
    mockRedis.incr.mockResolvedValueOnce(config.audioSepDailyRateLimitPerUser + 1);
    await expect(checkDailyRateLimit('user-1')).rejects.toThrow(SeparationRateLimitedError);
  });

  it('sets a 24h expiry only on the first call of the day', async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    await checkDailyRateLimit('user-1');
    expect(mockRedis.expire).toHaveBeenCalledWith(expect.stringContaining('audio_sep_rl:user-1:'), 86400);
  });

  it('does not re-set expiry on subsequent calls the same day', async () => {
    mockRedis.incr.mockResolvedValueOnce(2);
    await checkDailyRateLimit('user-1');
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });
});

// ─── createAudioSeparationJob ────────────────────────────────────────────────────

describe('createAudioSeparationJob', () => {
  const CREATED_ROW = { id: 'job-1', user_id: 'user-1', project_id: 'project-1', status: 'pending', cost_credits: 2 };

  it('deducts credits atomically, inserts a pending row, and writes a deduct ledger row', async () => {
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW])) // verifyClipOwnership
      .mockReturnValueOnce(makePlainSelectChain([])); // idempotency existing-check: none
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [CREATED_ROW] });

    const result = await createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-1',
    });

    expect(result.created).toBe(true);
    expect(result.row).toEqual(CREATED_ROW);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/credits_balance >= /);
    expect(sqlText).toMatch(/INSERT INTO credit_transactions/);
    expect(sqlText).toMatch(/generation_deduct/);
    expect(sqlText).toMatch(/INSERT INTO audio_separation_jobs/);
  });

  it('is idempotent: the same (userId, idempotencyKey) twice returns the same row and does NOT double-deduct', async () => {
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]))
      .mockReturnValueOnce(makePlainSelectChain([])); // first call: no existing row
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [CREATED_ROW] });

    const first = await createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-1',
    });

    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]))
      .mockReturnValueOnce(makePlainSelectChain([CREATED_ROW])); // second call: existing row found

    const second = await createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-1',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row).toEqual(first.row);
    expect(mockDb.execute).toHaveBeenCalledTimes(1); // deduct only ran once, total
  });

  it('throws InsufficientSeparationCreditsError and does not surface a job row when balance is too low', async () => {
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]))
      .mockReturnValueOnce(makePlainSelectChain([]));
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] }); // WHERE credits_balance >= cost matched nothing

    await expect(createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-2',
    })).rejects.toThrow(InsufficientSeparationCreditsError);
  });

  it('rejects a clip owned by another user before spending any credits', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([]));

    await expect(createAudioSeparationJob({
      userId: 'user-attacker', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-3',
    })).rejects.toThrow(AudioSeparationNotFoundError);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt', async () => {
    await expect(createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: '   ', idempotencyKey: 'idem-4',
    })).rejects.toThrow(AudioSeparationValidationError);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('re-selects the existing row on a 23505 idempotency-key race instead of throwing', async () => {
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]))
      .mockReturnValueOnce(makePlainSelectChain([])) // no existing row seen pre-insert
      .mockReturnValueOnce(makePlainSelectChain([CREATED_ROW])); // re-select after race
    (mockDb.execute as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    const result = await createAudioSeparationJob({
      userId: 'user-1', clipId: 'clip-1', prompt: 'background music', idempotencyKey: 'idem-race',
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(CREATED_ROW);
  });
});

// ─── markAudioSeparationProcessing ──────────────────────────────────────────────

describe('markAudioSeparationProcessing', () => {
  it('transitions pending -> processing', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'processing' }] });
    const row = await markAudioSeparationProcessing('job-1');
    expect(row).toEqual({ id: 'job-1', status: 'processing' });
  });

  it('returns null (idempotent re-run guard) when the row is already completed/refunded/processing', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    const row = await markAudioSeparationProcessing('job-1');
    expect(row).toBeNull();
  });
});

// ─── completeAudioSeparation ─────────────────────────────────────────────────────

describe('completeAudioSeparation', () => {
  it('status-guards the completion UPDATE to pending/processing', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });
    const ok = await completeAudioSeparation({
      id: 'job-1', targetR2Key: 'k-target', residualR2Key: 'k-residual', targetClipId: 'clip-t', residualClipId: 'clip-r',
    });
    expect(ok).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/status IN \('pending', 'processing'\)/);
  });
});

// ─── attachSeparationStems ───────────────────────────────────────────────────────

describe('attachSeparationStems', () => {
  const JOB = {
    id: 'job-1',
    project_id: 'project-1',
    source_clip_id: 'clip-1',
    prompt: 'background music',
    duration_seconds: 10,
  } as unknown as AudioSeparationJob;

  // WP1 Task 1.2: attachSeparationStems now batches all five steps through a single db.batch([...])
  // call (neon-http has no interactive db.transaction — see the function's own doc comment) instead
  // of sequential db.execute/db.insert calls, so the mock wires db.execute/db.insert to build query
  // descriptors (asserted on for shape) and db.batch to supply the five positional results.
  function wireHappyPath(priorVolume: number) {
    (mockDb.execute as jest.Mock).mockImplementation((query: unknown) => ({ __sql: extractSql(query) }));

    const residualValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({ __insert: 'residual' }) });
    const targetValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({ __insert: 'target' }) });
    (mockDb.insert as jest.Mock)
      .mockReturnValueOnce({ values: residualValues })
      .mockReturnValueOnce({ values: targetValues });

    (mockDb.batch as jest.Mock).mockImplementation(async () => [
      { rows: [{ source_prior_volume: priorVolume }] }, // 1. capture
      { rows: [] },                                     // 2. soft-delete prior live stems
      [{ id: 'residual-clip-id' }],                      // 3. insert residual .returning()
      [{ id: 'target-clip-id' }],                        // 4. insert target .returning()
      { rows: [{ id: 'clip-1' }] },                       // 5. mute source
    ]);

    return { residualValues, targetValues };
  }

  it('batches all five steps atomically through a single db.batch call (capture, soft-delete-prior, insert x2, mute)', async () => {
    wireHappyPath(0.7);

    const result = await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });

    expect(mockDb.batch).toHaveBeenCalledTimes(1);
    expect((mockDb.batch as jest.Mock).mock.calls[0][0]).toHaveLength(5);
    expect(result.sourcePriorVolume).toBe(0.7);
  });

  it('restores the EXACT pre-mute volume (e.g. 0.7), never a hardcoded default', async () => {
    wireHappyPath(0.7);
    const result = await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    expect(result.sourcePriorVolume).toBe(0.7);
    expect(result.sourcePriorVolume).not.toBe(1); // not the hardcoded default
  });

  it('inserts a correct partition: residual enabled=true sort_order=0, target(isolated) enabled=false sort_order=1, both tagged with job identity', async () => {
    const { residualValues, targetValues } = wireHappyPath(1);

    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });

    expect(residualValues.mock.calls[0][0]).toMatchObject({
      enabled: true, source_type: 'separation', source_clip_id: 'clip-1',
      separation_job_id: 'job-1', separation_role: 'residual', sort_order: 0,
    });
    expect(targetValues.mock.calls[0][0]).toMatchObject({
      enabled: false, source_type: 'separation', source_clip_id: 'clip-1',
      separation_job_id: 'job-1', separation_role: 'target', sort_order: 1,
    });
  });

  it('soft-deletes (never hard-deletes) any prior live stems for the same source clip before inserting the new pair', async () => {
    wireHappyPath(1);
    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    const softDeleteCall = (mockDb.execute as jest.Mock).mock.calls.find((call) => extractSql(call[0]).includes('SET deleted_at = now()'));
    expect(softDeleteCall).toBeDefined();
    const sqlText = extractSql(softDeleteCall![0]);
    expect(sqlText).toMatch(/UPDATE project_audio_clips/);
    expect(sqlText).toMatch(/source_type = 'separation'/);
    expect(sqlText).not.toMatch(/DELETE FROM/); // never a hard delete
  });

  it('carries the prior volume forward from the OLDEST live stem\'s job (COALESCE), never re-reading the already-muted project_clips.volume', async () => {
    wireHappyPath(0.7);
    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    const captureCall = (mockDb.execute as jest.Mock).mock.calls.find((call) => extractSql(call[0]).includes('source_prior_volume = COALESCE'));
    expect(captureCall).toBeDefined();
    const sqlText = extractSql(captureCall![0]);
    expect(sqlText).toMatch(/ORDER BY j2\.created_at ASC/);
    expect(sqlText).toMatch(/a2\.deleted_at IS NULL/);
    expect(sqlText).toMatch(/SELECT volume FROM project_clips/); // fallback only when no live stems exist
  });

  it('mutes the source clip via project_clips.volume = 0 (not an audio-clip enabled flag)', async () => {
    wireHappyPath(1);
    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    const muteCall = (mockDb.execute as jest.Mock).mock.calls.find((call) => extractSql(call[0]).includes('SET volume = 0'));
    expect(muteCall).toBeDefined();
    expect(extractSql(muteCall![0])).toMatch(/UPDATE project_clips/);
  });

  it('returns both new clip ids', async () => {
    wireHappyPath(1);
    const result = await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    expect(result.residualClipId).toBe('residual-clip-id');
    expect(result.targetClipId).toBe('target-clip-id');
  });
});

// ─── refundAudioSeparation ────────────────────────────────────────────────────────

describe('refundAudioSeparation', () => {
  it('transitions pending/processing/failed -> refunded and restores cost_credits exactly once', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] });

    const ok = await refundAudioSeparation('job-1', 'provider_error', 'fal call failed after retries');

    expect(ok).toBe(true);
    const sqlText = extractSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/credits_balance \+/);
    expect(sqlText).toMatch(/status IN \('pending', 'processing', 'failed'\)/);
  });

  it('returns false (no double-refund) on a second call once already refunded', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] }); // status guard no longer matches

    const ok = await refundAudioSeparation('job-1', 'provider_error', 'already refunded');

    expect(ok).toBe(false);
  });
});
