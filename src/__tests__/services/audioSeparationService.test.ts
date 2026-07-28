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
  resolveSourceClipTimelineOffset,
  resolveSeparationSource,
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

// extractSql only walks the top level, which is enough for the raw sql`...` templates this
// service issues. Composed predicates (and(eq(...), isNull(...))) nest SQL objects inside
// queryChunks, so flatten those recursively to inspect what a builder-style .where() was given.
function deepSql(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(deepSql).join('');
  if (typeof node !== 'object') return '';
  const obj = node as { queryChunks?: unknown[]; value?: unknown; name?: unknown };
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(deepSql).join('');
  if (obj.value !== undefined) return deepSql(obj.value);
  if (typeof obj.name === 'string') return obj.name;
  return '';
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

// Ordered select chain: db.select().from(table).where(...).orderBy(...) — the timeline scan.
function makeOrderedSelectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue(rows);
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

// ─── resolveSourceClipTimelineOffset ──────────────────────────────────────────
//
// Stems must land at the source clip's position on the project timeline, not at 0 — a separation
// of clip 3 has to play over clip 3's lane. The offset is the summed visible duration of every
// earlier clip, so these tests pin the summation, the ordering it depends on, and the fallbacks.

describe('resolveSourceClipTimelineOffset', () => {
  const c = (id: string, start: number, end: number) => ({
    id,
    trim_start_seconds: start,
    trim_end_seconds: end,
    original_duration_seconds: end - start,
  });

  it('returns 0 for the first clip on the timeline', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makeOrderedSelectChain([c('clip-1', 0, 4), c('clip-2', 0, 6)]),
    );
    await expect(resolveSourceClipTimelineOffset('project-1', 'clip-1')).resolves.toBe(0);
  });

  it('sums the VISIBLE (trimmed) durations of every earlier clip, not their original lengths', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makeOrderedSelectChain([
        // 30s source trimmed down to 4 visible seconds — the timeline only advances by 4.
        { id: 'clip-1', trim_start_seconds: 10, trim_end_seconds: 14, original_duration_seconds: 30 },
        { id: 'clip-2', trim_start_seconds: 0, trim_end_seconds: 6, original_duration_seconds: 6 },
        c('clip-3', 0, 5),
      ]),
    );
    await expect(resolveSourceClipTimelineOffset('project-1', 'clip-3')).resolves.toBe(10);
  });

  it('orders the scan explicitly and excludes soft-deleted clips from the sum', async () => {
    const chain = makeOrderedSelectChain([c('clip-1', 0, 3), c('clip-2', 0, 2)]);
    (mockDb.select as jest.Mock).mockReturnValueOnce(chain);

    await resolveSourceClipTimelineOffset('project-1', 'clip-2');

    // Offsets are positional, so an unordered scan would sum an arbitrary set of "earlier" clips.
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    // A deleted_at IS NULL predicate must be part of the where — a removed clip occupies no lane.
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(deepSql(chain.where.mock.calls[0][0])).toMatch(/is null/i);
  });

  it('rounds the accumulated offset to 3 decimals (no float drift into the DB column)', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makeOrderedSelectChain([c('clip-1', 0, 0.1), c('clip-2', 0, 0.2), c('clip-3', 0, 5)]),
    );
    await expect(resolveSourceClipTimelineOffset('project-1', 'clip-3')).resolves.toBe(0.3);
  });

  it('falls back to 0 when the source clip is not in the project (rather than throwing)', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOrderedSelectChain([c('clip-1', 0, 4)]));
    await expect(resolveSourceClipTimelineOffset('project-1', 'ghost-clip')).resolves.toBe(0);
  });

  it('skips an earlier clip with no resolvable duration instead of aborting the whole placement', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makeOrderedSelectChain([
        c('clip-1', 0, 4),
        { id: 'clip-2', trim_start_seconds: 0, trim_end_seconds: null, original_duration_seconds: null },
        c('clip-3', 0, 5),
      ]),
    );
    // clip-2 contributes nothing, but clip-1's 4s still places clip-3 correctly.
    await expect(resolveSourceClipTimelineOffset('project-1', 'clip-3')).resolves.toBe(4);
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
      start_offset_seconds: 0,
    });
    expect(targetValues.mock.calls[0][0]).toMatchObject({
      enabled: false, source_type: 'separation', source_clip_id: 'clip-1',
      separation_job_id: 'job-1', separation_role: 'target', sort_order: 1,
      start_offset_seconds: 0,
    });
  });

  it('places both stems at the source clip timeline offset (not project 0)', async () => {
    const { residualValues, targetValues } = wireHappyPath(1);

    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual',
      residualLabel: 'Everything else', targetLabel: 'background music',
      startOffsetSeconds: 4.25,
    });

    expect(residualValues.mock.calls[0][0]).toMatchObject({ start_offset_seconds: 4.25 });
    expect(targetValues.mock.calls[0][0]).toMatchObject({ start_offset_seconds: 4.25 });
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

  it('defaults to 0 when no offset is supplied, and clamps a negative offset to 0', async () => {
    const noOffset = wireHappyPath(1);
    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual', residualLabel: 'Everything else', targetLabel: 'background music',
    });
    expect(noOffset.residualValues.mock.calls[0][0]).toMatchObject({ start_offset_seconds: 0 });

    jest.clearAllMocks();
    const negative = wireHappyPath(1);
    await attachSeparationStems({
      job: JOB, targetR2Key: 'k-target', residualR2Key: 'k-residual',
      residualLabel: 'Everything else', targetLabel: 'background music',
      startOffsetSeconds: -3,
    });
    expect(negative.residualValues.mock.calls[0][0]).toMatchObject({ start_offset_seconds: 0 });
    expect(negative.targetValues.mock.calls[0][0]).toMatchObject({ start_offset_seconds: 0 });
  });
});

// ─── attachSeparationStems: chained (audio-clip source) ───────────────────────
//
// Separating a stem must behave like separating a clip EXCEPT for the three things that are
// inherently clip-specific: what gets silenced, how prior live stems are scoped, and what undo
// restores. These pin exactly those differences.

describe('attachSeparationStems — chained from a stem', () => {
  const PARENT_STEM_ID = 'stem-parent-1';
  const CHAINED_JOB = {
    id: 'job-2',
    project_id: 'project-1',
    source_clip_id: 'clip-1',      // root provenance survives at every depth
    source_audio_clip_id: PARENT_STEM_ID,
    prompt: 'drums',
    duration_seconds: 8,
  } as unknown as AudioSeparationJob;

  function wireChained(priorEnabled: boolean, priorGain: number) {
    (mockDb.execute as jest.Mock).mockImplementation((query: unknown) => ({ __sql: extractSql(query) }));

    const residualValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({ __insert: 'residual' }) });
    const targetValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({ __insert: 'target' }) });
    (mockDb.insert as jest.Mock)
      .mockReturnValueOnce({ values: residualValues })
      .mockReturnValueOnce({ values: targetValues });

    (mockDb.batch as jest.Mock).mockImplementation(async () => [
      { rows: [{ source_prior_enabled: priorEnabled, source_prior_gain: priorGain }] },
      { rows: [] },
      [{ id: 'residual-2' }],
      [{ id: 'target-2' }],
      { rows: [{ id: PARENT_STEM_ID }] },
    ]);

    return { residualValues, targetValues };
  }

  const baseInput = {
    job: CHAINED_JOB,
    targetR2Key: 'k-target-2',
    residualR2Key: 'k-residual-2',
    residualLabel: 'Everything else',
    targetLabel: 'drums',
  };

  it('links both new stems to the parent stem and stores them one level deeper', async () => {
    const { residualValues, targetValues } = wireChained(true, 1);

    await attachSeparationStems({ ...baseInput, sourceDepth: 1, rootClipId: 'clip-1', startOffsetSeconds: 4 });

    for (const values of [residualValues, targetValues]) {
      expect(values.mock.calls[0][0]).toMatchObject({
        parent_audio_clip_id: PARENT_STEM_ID,
        separation_depth: 2,
        source_clip_id: 'clip-1',   // root provenance carried down
        start_offset_seconds: 4,
      });
    }
  });

  it('keeps the residual/target partition identical to a clip-sourced separation', async () => {
    const { residualValues, targetValues } = wireChained(true, 1);

    await attachSeparationStems({ ...baseInput, sourceDepth: 1 });

    expect(residualValues.mock.calls[0][0]).toMatchObject({ separation_role: 'residual', enabled: true, sort_order: 0 });
    expect(targetValues.mock.calls[0][0]).toMatchObject({ separation_role: 'target', enabled: false, sort_order: 1 });
  });

  it('scopes the soft-delete of prior stems by PARENT, so a sibling stem\'s children survive', async () => {
    wireChained(true, 1);

    await attachSeparationStems({ ...baseInput, sourceDepth: 1 });

    const softDelete = (mockDb.execute as jest.Mock).mock.calls
      .find((call) => extractSql(call[0]).includes('SET deleted_at = now()'));
    expect(softDelete).toBeDefined();
    const sqlText = extractSql(softDelete![0]);
    expect(sqlText).toMatch(/parent_audio_clip_id =/);
    // Scoping by source_clip_id here would nuke every stem sharing the same root clip.
    expect(sqlText).not.toMatch(/WHERE source_clip_id =/);
    expect(sqlText).not.toMatch(/DELETE FROM/);
  });

  it('silences the source by DISABLING the stem, never by muting the root clip', async () => {
    wireChained(true, 1);

    await attachSeparationStems({ ...baseInput, sourceDepth: 1 });

    const sqls = (mockDb.execute as jest.Mock).mock.calls.map((call) => extractSql(call[0]));
    expect(sqls.some((s) => /UPDATE project_audio_clips SET enabled = false/.test(s))).toBe(true);
    // Muting project_clips would silence the original video clip a level above — wrong node.
    expect(sqls.some((s) => /UPDATE project_clips SET volume = 0/.test(s))).toBe(false);
  });

  it('captures the source stem\'s prior enabled/gain for undo, carrying forward from the oldest live pair', async () => {
    wireChained(true, 0.6);

    const result = await attachSeparationStems({ ...baseInput, sourceDepth: 1 });

    expect(result.sourcePriorEnabled).toBe(true);
    expect(result.sourcePriorGain).toBe(0.6);

    const capture = (mockDb.execute as jest.Mock).mock.calls
      .find((call) => extractSql(call[0]).includes('source_prior_enabled = COALESCE'));
    expect(capture).toBeDefined();
    const sqlText = extractSql(capture![0]);
    // Same carry-forward shape as the clip path: oldest live child pair wins over the (already
    // mutated) current row, or a re-separation would capture the disabled state and strand undo.
    expect(sqlText).toMatch(/ORDER BY j2\.created_at ASC/);
    expect(sqlText).toMatch(/a2\.deleted_at IS NULL/);
    expect(sqlText).toMatch(/source_prior_gain = COALESCE/);
  });

  it('still batches all five steps atomically', async () => {
    wireChained(true, 1);
    await attachSeparationStems({ ...baseInput, sourceDepth: 1 });
    expect(mockDb.batch).toHaveBeenCalledTimes(1);
    expect((mockDb.batch as jest.Mock).mock.calls[0][0]).toHaveLength(5);
  });

  it('defaults a missing gain/enabled capture to unity rather than silencing the stem forever', async () => {
    (mockDb.execute as jest.Mock).mockImplementation((query: unknown) => ({ __sql: extractSql(query) }));
    (mockDb.insert as jest.Mock)
      .mockReturnValueOnce({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({}) }) })
      .mockReturnValueOnce({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({}) }) });
    (mockDb.batch as jest.Mock).mockImplementation(async () => [
      { rows: [{ source_prior_enabled: null, source_prior_gain: null }] },
      { rows: [] },
      [{ id: 'residual-2' }],
      [{ id: 'target-2' }],
      { rows: [] },
    ]);

    const result = await attachSeparationStems({ ...baseInput, sourceDepth: 1 });

    expect(result.sourcePriorEnabled).toBe(true);
    expect(result.sourcePriorGain).toBe(1);
  });
});

// ─── clip-sourced stems record their tree position too ────────────────────────

describe('attachSeparationStems — tree fields on a clip-sourced pair', () => {
  it('stores depth 1 with a null parent, so chaining can hang children off either stem', async () => {
    (mockDb.execute as jest.Mock).mockImplementation((query: unknown) => ({ __sql: extractSql(query) }));
    const residualValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({}) });
    const targetValues = jest.fn().mockReturnValue({ returning: jest.fn().mockReturnValue({}) });
    (mockDb.insert as jest.Mock)
      .mockReturnValueOnce({ values: residualValues })
      .mockReturnValueOnce({ values: targetValues });
    (mockDb.batch as jest.Mock).mockImplementation(async () => [
      { rows: [{ source_prior_volume: 1 }] }, { rows: [] },
      [{ id: 'r' }], [{ id: 't' }], { rows: [] },
    ]);

    await attachSeparationStems({
      job: { id: 'job-1', project_id: 'project-1', source_clip_id: 'clip-1', source_audio_clip_id: null, prompt: 'background music', duration_seconds: 10 } as unknown as AudioSeparationJob,
      targetR2Key: 'k-t', residualR2Key: 'k-r', residualLabel: 'Everything else', targetLabel: 'background music',
    });

    for (const values of [residualValues, targetValues]) {
      expect(values.mock.calls[0][0]).toMatchObject({
        parent_audio_clip_id: null,
        separation_depth: 1,
        source_clip_id: 'clip-1',
      });
    }
  });
});

// ─── resolveSeparationSource ──────────────────────────────────────────────────

describe('resolveSeparationSource', () => {
  it('rejects supplying both a clip and an audio clip', async () => {
    await expect(resolveSeparationSource({ clipId: 'c', audioClipId: 'a' }, 'user-1'))
      .rejects.toBeInstanceOf(AudioSeparationValidationError);
  });

  it('rejects supplying neither', async () => {
    await expect(resolveSeparationSource({}, 'user-1'))
      .rejects.toBeInstanceOf(AudioSeparationValidationError);
  });

  it('resolves a clip source and prices it from the clip duration', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([{ ...OWNED_CLIP_ROW, r2_key: 'projects/p/clip.mp4' }]));

    const source = await resolveSeparationSource({ clipId: 'clip-1' }, 'user-1');

    expect(source).toMatchObject({ kind: 'clip', id: 'clip-1', projectId: 'project-1', durationSeconds: 10 });
  });

  it('resolves a stem source and prices it from the stem duration', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([{
      id: 'stem-1', project_id: 'project-1', r2_key: 'audio-separation/j/residual.mp3',
      enabled: true, gain: 1, start_offset_seconds: 4, separation_depth: 1, source_clip_id: 'clip-1',
      trim_start_seconds: 0, trim_end_seconds: 6, original_duration_seconds: 6,
    }]));

    const source = await resolveSeparationSource({ audioClipId: 'stem-1' }, 'user-1');

    expect(source).toMatchObject({ kind: 'audio_clip', id: 'stem-1', projectId: 'project-1', durationSeconds: 6 });
  });

  it('throws NotFound for a stem owned by another user (no existence leak)', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([]));

    await expect(resolveSeparationSource({ audioClipId: 'stem-1' }, 'user-1'))
      .rejects.toBeInstanceOf(AudioSeparationNotFoundError);
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
