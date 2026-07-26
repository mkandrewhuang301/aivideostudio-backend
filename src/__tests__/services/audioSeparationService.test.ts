// src/__tests__/services/audioSeparationService.test.ts
// Unit tests for audioSeparationService — quote math, ownership scoping, daily rate-limit
// (Task 1). Task 2 (atomic-deduct create, status transitions, attach-stems, refund) tests are
// appended by the follow-up commit. All DB/Redis calls are mocked: no live Neon/Redis connection
// required.
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
import {
  resolveClipDurationSeconds,
  verifyClipOwnership,
  quoteAudioSeparation,
  checkDailyRateLimit,
  AudioSeparationNotFoundError,
  AudioSeparationValidationError,
  SeparationRateLimitedError,
} from '../../services/audioSeparationService';

const mockDb = db as jest.Mocked<typeof db>;
const mockRedis = redis as unknown as { incr: jest.Mock; expire: jest.Mock };

// Ownership-select chain: db.select({...}).from(projectClips).innerJoin(projects, ...).where(...)
function makeOwnershipChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
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
