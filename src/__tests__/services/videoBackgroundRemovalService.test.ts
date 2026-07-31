// src/__tests__/services/videoBackgroundRemovalService.test.ts
// Unit tests for videoBackgroundRemovalService — credit math, the iOS-playability container
// mapping, server-side duration resolution, ownership scoping, daily rate-limit, in-flight guard,
// idempotent atomic-deduct create, capture-before-swap ordering, and guarded undo. All DB/Redis/
// provider calls are mocked: no live Neon/Redis/fal connection required.
//
// Placed under src/__tests__/services/ (not src/services/) to match jest.config.ts's testMatch
// `**/__tests__/**/*.test.ts` and every other service test in this codebase.

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
    batch: jest.fn(),
  },
}));
jest.mock('../../redis/client', () => ({ redis: { incr: jest.fn(), expire: jest.fn() } }));
jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: jest.fn().mockResolvedValue('https://r2.example/presigned'),
}));
jest.mock('../../services/mediaProbe', () => ({ probeDurationSeconds: jest.fn() }));
// Config is mocked (not loaded from real env) so this suite runs standalone.
jest.mock('../../config', () => ({
  config: {
    videoBgRemovalEnabled: true,
    videoBgRemovalModel: 'bria/video/background-removal/v3',
    videoBgRemovalCreditsPerSecond: 0.42,
    videoBgRemovalMaxDurationSeconds: 180,
    videoBgRemovalWorkerConcurrency: 2,
    videoBgRemovalRequestsPerMinute: 8,
    videoBgRemovalDailyRateLimitPerUser: 30,
  },
}));

import { db } from '../../db/client';
import { redis } from '../../redis/client';
import { probeDurationSeconds } from '../../services/mediaProbe';
import type { VideoBackgroundRemovalJob } from '../../db/schema';
import {
  applyBackgroundRemovalToClip,
  checkDailyRateLimit,
  completeBgRemoval,
  computeBgRemovalCredits,
  createVideoBackgroundRemovalJob,
  markBgRemovalProcessing,
  parseBackgroundColor,
  quoteVideoBackgroundRemoval,
  refundBgRemoval,
  resolveBillableDuration,
  resolveOutputContainer,
  resolveOutputExtension,
  undoBackgroundRemoval,
  verifyClipOwnership,
  BgRemovalInProgressError,
  BgRemovalRateLimitedError,
  InsufficientBgRemovalCreditsError,
  VideoBgRemovalNotFoundError,
  VideoBgRemovalValidationError,
} from '../../services/videoBackgroundRemovalService';

const mockDb = db as jest.Mocked<typeof db>;
const mockRedis = redis as unknown as { incr: jest.Mock; expire: jest.Mock };
const mockProbe = probeDurationSeconds as jest.Mock;

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

// Update chain: db.update(table).set({...}).where(...)
function makeUpdateChain() {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(undefined);
  return chain;
}

const OWNED_CLIP_ROW = {
  id: 'clip-1',
  project_id: 'project-1',
  r2_key: 'clips/clip-1.mp4',
  media_type: 'video',
  original_duration_seconds: 10,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Credit math ──────────────────────────────────────────────────────────────
// Credits = provider cost in cents, rounded up. Bria v3 is $0.0042/s = 0.42 cents/s.

describe('computeBgRemovalCredits', () => {
  it('bills a 10s clip at 5 credits (ceil(10 × 0.42) = ceil(4.2))', () => {
    expect(computeBgRemovalCredits(10)).toBe(5);
  });

  it('bills a 60s clip at 26 credits (ceil(25.2))', () => {
    expect(computeBgRemovalCredits(60)).toBe(26);
  });

  it('always rounds UP — a fractional cent is never given away', () => {
    expect(computeBgRemovalCredits(5)).toBe(3); // 2.1 -> 3
    expect(computeBgRemovalCredits(30)).toBe(13); // 12.6 -> 13
  });

  it('floors at 1 credit so a sub-second clip is never free', () => {
    expect(computeBgRemovalCredits(0.5)).toBe(1);
    expect(computeBgRemovalCredits(0.01)).toBe(1);
  });
});

// ─── Container mapping (the iOS playability trap) ─────────────────────────────
// Bria's OWN default is webm_vp9, which iOS AVPlayer cannot decode. A job that shipped that would
// bill correctly and then play as a black rectangle on device. These tests pin the mapping so a
// future edit cannot silently reintroduce the default.

describe('resolveOutputContainer', () => {
  it('maps Transparent to mov_h265 — HEVC with alpha, which iOS plays natively', () => {
    expect(resolveOutputContainer('Transparent')).toBe('mov_h265');
  });

  it('maps every solid color to mp4_h264', () => {
    for (const color of ['Black', 'White', 'Gray', 'Green', 'Blue', 'Magenta'] as const) {
      expect(resolveOutputContainer(color)).toBe('mp4_h264');
    }
  });

  it('NEVER returns webm_vp9 for any supported background', () => {
    const colors = ['Transparent', 'Black', 'White', 'Gray', 'Red', 'Green', 'Blue', 'Yellow', 'Cyan', 'Magenta', 'Orange'] as const;
    for (const color of colors) {
      expect(resolveOutputContainer(color)).not.toBe('webm_vp9');
    }
  });
});

describe('resolveOutputExtension', () => {
  it('gives .mov to mov_ containers and .mp4 otherwise', () => {
    expect(resolveOutputExtension('mov_h265')).toBe('mov');
    expect(resolveOutputExtension('mp4_h264')).toBe('mp4');
  });
});

describe('parseBackgroundColor', () => {
  it('defaults to Transparent when omitted', () => {
    expect(parseBackgroundColor(undefined)).toBe('Transparent');
    expect(parseBackgroundColor(null)).toBe('Transparent');
  });

  it('accepts a valid enum value', () => {
    expect(parseBackgroundColor('Green')).toBe('Green');
  });

  it('rejects an unknown value rather than silently falling back', () => {
    expect(() => parseBackgroundColor('Chartreuse')).toThrow(VideoBgRemovalValidationError);
    expect(() => parseBackgroundColor('transparent')).toThrow(VideoBgRemovalValidationError); // case-sensitive
    expect(() => parseBackgroundColor(42)).toThrow(VideoBgRemovalValidationError);
  });
});

// ─── Ownership scoping ────────────────────────────────────────────────────────

describe('verifyClipOwnership', () => {
  it('returns the clip when owned', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]));
    await expect(verifyClipOwnership('clip-1', 'user-1')).resolves.toEqual(OWNED_CLIP_ROW);
  });

  it('throws NotFound (never 403) for a foreign clip — no existence leak', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([]));
    await expect(verifyClipOwnership('clip-1', 'other-user')).rejects.toBeInstanceOf(VideoBgRemovalNotFoundError);
  });

  it('scopes the query by user and excludes soft-deleted clips', async () => {
    const chain = makeOwnershipChain([OWNED_CLIP_ROW]);
    (mockDb.select as jest.Mock).mockReturnValueOnce(chain);
    await verifyClipOwnership('clip-1', 'user-1');
    const where = deepSql(chain.where.mock.calls[0][0]);
    expect(where).toContain('user_id');
    expect(where).toContain('deleted_at');
  });
});

// ─── Duration resolution (CLAUDE.md rule #7) ──────────────────────────────────
// This is a per-second-billed provider, so an unverifiable duration must BLOCK the charge rather
// than fall back to an estimate.

describe('resolveBillableDuration', () => {
  it('uses original_duration_seconds when present, without probing', async () => {
    await expect(resolveBillableDuration(OWNED_CLIP_ROW)).resolves.toBe(10);
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('self-heals a null duration via ffprobe and persists the probed value', async () => {
    mockProbe.mockResolvedValueOnce(12.5);
    const updateChain = makeUpdateChain();
    (mockDb.update as jest.Mock).mockReturnValueOnce(updateChain);

    await expect(
      resolveBillableDuration({ ...OWNED_CLIP_ROW, original_duration_seconds: null }),
    ).resolves.toBe(12.5);

    expect(mockProbe).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith({ original_duration_seconds: 12.5 });
  });

  it('THROWS when duration is unresolvable — never bills from a guess', async () => {
    mockProbe.mockResolvedValueOnce(null);
    await expect(
      resolveBillableDuration({ ...OWNED_CLIP_ROW, original_duration_seconds: null }),
    ).rejects.toBeInstanceOf(VideoBgRemovalValidationError);
  });

  it('rejects a clip longer than the configured cap', async () => {
    await expect(
      resolveBillableDuration({ ...OWNED_CLIP_ROW, original_duration_seconds: 240 }),
    ).rejects.toBeInstanceOf(VideoBgRemovalValidationError);
  });

  it('rounds to 3 decimals', async () => {
    await expect(
      resolveBillableDuration({ ...OWNED_CLIP_ROW, original_duration_seconds: 26.6666 }),
    ).resolves.toBe(26.667);
  });
});

// ─── Quote ────────────────────────────────────────────────────────────────────

describe('quoteVideoBackgroundRemoval', () => {
  it('quotes duration + credits for an owned video clip', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]));
    await expect(quoteVideoBackgroundRemoval('clip-1', 'user-1')).resolves.toEqual({
      supported: true,
      duration_seconds: 10,
      cost_credits: 5,
    });
  });

  it('rejects an image clip — background removal is video-only here', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makeOwnershipChain([{ ...OWNED_CLIP_ROW, media_type: 'image' }]),
    );
    await expect(quoteVideoBackgroundRemoval('clip-1', 'user-1')).rejects.toBeInstanceOf(VideoBgRemovalValidationError);
  });
});

// ─── Daily rate limit ─────────────────────────────────────────────────────────

describe('checkDailyRateLimit', () => {
  it('sets a 24h TTL on the first call of the day', async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    await checkDailyRateLimit('user-1');
    expect(mockRedis.expire).toHaveBeenCalledWith(expect.stringContaining('video_bg_rl:user-1:'), 86400);
  });

  it('allows calls up to the cap', async () => {
    mockRedis.incr.mockResolvedValueOnce(30);
    await expect(checkDailyRateLimit('user-1')).resolves.toBeUndefined();
  });

  it('throws once past the cap', async () => {
    mockRedis.incr.mockResolvedValueOnce(31);
    await expect(checkDailyRateLimit('user-1')).rejects.toBeInstanceOf(BgRemovalRateLimitedError);
  });
});

// ─── Create (atomic deduct) ───────────────────────────────────────────────────

describe('createVideoBackgroundRemovalJob', () => {
  const baseInput = {
    userId: 'user-1',
    clipId: 'clip-1',
    backgroundColor: 'Transparent' as const,
    idempotencyKey: 'key-1',
  };

  function primeCreatePath(existingJobRows: unknown[] = [], inFlightRows: unknown[] = []) {
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW])) // verifyClipOwnership
      .mockReturnValueOnce(makePlainSelectChain(existingJobRows)) // idempotency lookup
      .mockReturnValueOnce(makePlainSelectChain(inFlightRows)); // in-flight guard
  }

  it('returns the existing row on an idempotency replay WITHOUT deducting again', async () => {
    const existing = { id: 'job-1', status: 'pending', cost_credits: 5 };
    (mockDb.select as jest.Mock)
      .mockReturnValueOnce(makeOwnershipChain([OWNED_CLIP_ROW]))
      .mockReturnValueOnce(makePlainSelectChain([existing]));

    const result = await createVideoBackgroundRemovalJob(baseInput);
    expect(result).toEqual({ row: existing, created: false });
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('deducts credits and inserts the job in ONE guarded statement (rule #1)', async () => {
    primeCreatePath();
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1', cost_credits: 5 }] });

    const result = await createVideoBackgroundRemovalJob(baseInput);
    expect(result.created).toBe(true);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);

    const statement = deepSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    // The balance guard IS the atomic check — never a separate SELECT then UPDATE.
    expect(statement).toContain('credits_balance >=');
    expect(statement).toContain('UPDATE users');
    expect(statement).toContain('credit_transactions');
    expect(statement).toContain('INSERT INTO video_background_removal_jobs');
  });

  it('throws InsufficientCredits when the guarded UPDATE matches no rows', async () => {
    primeCreatePath();
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await expect(createVideoBackgroundRemovalJob(baseInput)).rejects.toBeInstanceOf(InsufficientBgRemovalCreditsError);
  });

  it('rejects a second in-flight job for the same clip (protects undo state)', async () => {
    primeCreatePath([], [{ id: 'job-running' }]);
    await expect(createVideoBackgroundRemovalJob(baseInput)).rejects.toBeInstanceOf(BgRemovalInProgressError);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('resolves an idempotency-key race (23505) by re-selecting the winner', async () => {
    primeCreatePath();
    const raceWinner = { id: 'job-1', status: 'pending', cost_credits: 5 };
    (mockDb.execute as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    (mockDb.select as jest.Mock).mockReturnValueOnce(makePlainSelectChain([raceWinner]));

    await expect(createVideoBackgroundRemovalJob(baseInput)).resolves.toEqual({ row: raceWinner, created: false });
  });

  it('persists the derived container so a retry cannot switch it mid-flight', async () => {
    primeCreatePath();
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });
    await createVideoBackgroundRemovalJob({ ...baseInput, backgroundColor: 'Green' });

    const params = (mockDb.execute as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(params)).toContain('mp4_h264');
  });
});

// ─── Status transitions ───────────────────────────────────────────────────────

describe('status transitions', () => {
  it('markBgRemovalProcessing only advances a pending job', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'processing' }] });
    await markBgRemovalProcessing('job-1');
    const statement = deepSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(statement).toContain("status = 'pending'");
  });

  it('markBgRemovalProcessing returns null on a race', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await expect(markBgRemovalProcessing('job-1')).resolves.toBeNull();
  });

  it('completeBgRemoval only transitions from a non-terminal status', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });
    await completeBgRemoval({ id: 'job-1', outputR2Key: 'video-background-removal/job-1/output.mov' });
    const statement = deepSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(statement).toContain("status IN ('pending', 'processing')");
  });
});

// ─── Media swap: capture BEFORE overwrite ─────────────────────────────────────

describe('applyBackgroundRemovalToClip', () => {
  const JOB = {
    id: 'job-1',
    source_clip_id: 'clip-1',
  } as unknown as VideoBackgroundRemovalJob;

  // db.execute builds the query descriptors that db.batch then runs as one Neon transaction, so
  // (matching audioSeparationService.test.ts's attachSeparationStems suite) execute is wired to
  // echo its SQL back and the assertions read the execute call args in build order.
  function wireHappyPath() {
    (mockDb.execute as jest.Mock).mockImplementation((query: unknown) => ({ __sql: deepSql(query) }));
    (mockDb.batch as jest.Mock).mockResolvedValue([
      { rows: [{ source_prior_r2_key: 'clips/clip-1.mp4' }] }, // 1. capture
      { rows: [] },                                            // 2. swap media
    ]);
  }

  it('captures the prior key and swaps media in ONE batch, capture first', async () => {
    wireHappyPath();

    const result = await applyBackgroundRemovalToClip({
      job: JOB,
      outputR2Key: 'video-background-removal/job-1/output.mov',
    });
    expect(result.sourcePriorR2Key).toBe('clips/clip-1.mp4');

    expect(mockDb.batch).toHaveBeenCalledTimes(1);
    expect((mockDb.batch as jest.Mock).mock.calls[0][0]).toHaveLength(2);

    // Order is load-bearing: capture must READ project_clips.r2_key before the swap overwrites it.
    const statements = (mockDb.execute as jest.Mock).mock.calls.map((call) => deepSql(call[0]));
    expect(statements[0]).toContain('source_prior_r2_key');
    expect(statements[1]).toContain('UPDATE project_clips');
  });

  it('COALESCEs the capture so a retry cannot overwrite the true original with this job output', async () => {
    wireHappyPath();
    await applyBackgroundRemovalToClip({ job: JOB, outputR2Key: 'out.mov' });
    expect(deepSql((mockDb.execute as jest.Mock).mock.calls[0][0])).toContain('COALESCE');
  });
});

// ─── Refund ───────────────────────────────────────────────────────────────────

describe('refundBgRemoval', () => {
  it('restores credits and writes a refund ledger row in one statement', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] });
    await expect(refundBgRemoval('job-1', 'provider_unavailable', 'failed')).resolves.toBe(true);

    const statement = deepSql((mockDb.execute as jest.Mock).mock.calls[0][0]);
    expect(statement).toContain('credits_balance + transitioned.cost_credits');
    expect(statement).toContain('generation_refund');
    // Only refundable from a non-terminal/failed state — a completed job can never be refunded.
    expect(statement).toContain("status IN ('pending', 'processing', 'failed')");
  });

  it('returns false when the job was already terminal (no double refund)', async () => {
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await expect(refundBgRemoval('job-1', 'x', 'y')).resolves.toBe(false);
  });
});

// ─── Undo ─────────────────────────────────────────────────────────────────────

describe('undoBackgroundRemoval', () => {
  const COMPLETED_JOB = {
    id: 'job-1',
    user_id: 'user-1',
    source_clip_id: 'clip-1',
    status: 'completed',
    source_prior_r2_key: 'clips/clip-1.mp4',
    output_r2_key: 'video-background-removal/job-1/output.mov',
  };

  it('restores the original media', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makePlainSelectChain([COMPLETED_JOB]));
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ r2_key: 'clips/clip-1.mp4' }] });

    await expect(undoBackgroundRemoval('job-1', 'user-1')).resolves.toEqual({
      restoredR2Key: 'clips/clip-1.mp4',
    });
  });

  it('guards the restore on the clip still holding THIS job output — a stale undo cannot clobber newer media', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makePlainSelectChain([COMPLETED_JOB]));
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await expect(undoBackgroundRemoval('job-1', 'user-1')).rejects.toBeInstanceOf(VideoBgRemovalValidationError);
  });

  it('rejects a job owned by another user as NotFound', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makePlainSelectChain([COMPLETED_JOB]));
    await expect(undoBackgroundRemoval('job-1', 'other-user')).rejects.toBeInstanceOf(VideoBgRemovalNotFoundError);
  });

  it('rejects undo on a job that never completed', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(
      makePlainSelectChain([{ ...COMPLETED_JOB, status: 'refunded' }]),
    );
    await expect(undoBackgroundRemoval('job-1', 'user-1')).rejects.toBeInstanceOf(VideoBgRemovalValidationError);
  });

  it('does NOT refund — the provider work was performed and billed', async () => {
    (mockDb.select as jest.Mock).mockReturnValueOnce(makePlainSelectChain([COMPLETED_JOB]));
    (mockDb.execute as jest.Mock).mockResolvedValueOnce({ rows: [{ r2_key: 'clips/clip-1.mp4' }] });

    await undoBackgroundRemoval('job-1', 'user-1');
    const statements = (mockDb.execute as jest.Mock).mock.calls.map((call) => deepSql(call[0]));
    expect(statements.join(' ')).not.toContain('generation_refund');
  });
});
