// src/__tests__/routes/audioSeparation.test.ts
// Unit tests for the quote/trigger/status endpoints. Service layer + queue are mocked — no live
// DB/Redis/fal connection required (matches videoSummaries.test.ts's route-test convention).
//
// Placed under src/__tests__/routes/ (not src/routes/) — this repo's jest.config.ts testMatch is
// '**/__tests__/**/*.test.ts'; a file directly under src/routes/ would never be discovered
// (same deviation Plan 03 documented for the service-layer test file).

jest.mock('../../config', () => ({ config: { audioSepEnabled: true } }));

jest.mock('../../services/audioSeparationService', () => ({
  AudioSeparationNotFoundError: class AudioSeparationNotFoundError extends Error {},
  AudioSeparationValidationError: class AudioSeparationValidationError extends Error {},
  InsufficientSeparationCreditsError: class InsufficientSeparationCreditsError extends Error {},
  SeparationRateLimitedError: class SeparationRateLimitedError extends Error {},
  checkDailyRateLimit: jest.fn(),
  createAudioSeparationJob: jest.fn(),
  getAudioSeparationJob: jest.fn(),
  quoteAudioSeparation: jest.fn(),
  quoteAudioClipSeparation: jest.fn(),
  refundAudioSeparation: jest.fn(),
}));

jest.mock('../../queue/audioSeparationQueue', () => ({
  audioSeparationQueue: { add: jest.fn() },
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { audioSeparationRouter } from '../../routes/audioSeparation';
import { audioSeparationQueue } from '../../queue/audioSeparationQueue';
import {
  AudioSeparationNotFoundError,
  AudioSeparationValidationError,
  InsufficientSeparationCreditsError,
  SeparationRateLimitedError,
  checkDailyRateLimit,
  createAudioSeparationJob,
  getAudioSeparationJob,
  quoteAudioSeparation,
  quoteAudioClipSeparation,
  refundAudioSeparation,
} from '../../services/audioSeparationService';

const AUDIO_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const CLIP_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'db-user-1';

function buildApp(user: { uid: string; dbUserId: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user as never;
    next();
  });
  app.use('/api', audioSeparationRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkDailyRateLimit as jest.Mock).mockResolvedValue(undefined);
});

describe('GET /clips/:clipId/audio-separation/quote', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separation/quote`);
    expect(res.status).toBe(401);
  });

  it('returns 200 with the quote + enabled flag on success', async () => {
    (quoteAudioSeparation as jest.Mock).mockResolvedValue({
      supported: true, duration_seconds: 12, cost_credits: 2,
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separation/quote`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: true, duration_seconds: 12, cost_credits: 2, enabled: true });
  });

  it('returns 404 for a foreign/nonexistent clip (IDOR-safe, no existence leak)', async () => {
    (quoteAudioSeparation as jest.Mock).mockRejectedValue(new AudioSeparationNotFoundError());
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separation/quote`);
    expect(res.status).toBe(404);
  });
});

describe('POST /clips/:clipId/audio-separations', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .send({ prompt: 'background music' });
    expect(res.status).toBe(400);
    expect(createAudioSeparationJob).not.toHaveBeenCalled();
  });

  it('returns 400 when prompt is missing/empty', async () => {
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: '   ' });
    expect(res.status).toBe(400);
    expect(createAudioSeparationJob).not.toHaveBeenCalled();
  });

  it('returns 402 when the service reports insufficient credits', async () => {
    (createAudioSeparationJob as jest.Mock).mockRejectedValue(new InsufficientSeparationCreditsError());
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(402);
  });

  it('returns 404 for a foreign clip', async () => {
    (createAudioSeparationJob as jest.Mock).mockRejectedValue(new AudioSeparationNotFoundError());
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(404);
  });

  it('returns 422 on validation error', async () => {
    (createAudioSeparationJob as jest.Mock).mockRejectedValue(new AudioSeparationValidationError('bad clip'));
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(422);
  });

  it('returns 429 when the daily rate limit is exceeded', async () => {
    (checkDailyRateLimit as jest.Mock).mockRejectedValue(new SeparationRateLimitedError());
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(429);
    expect(createAudioSeparationJob).not.toHaveBeenCalled();
  });

  it('returns 202 with job id/status/cost on the happy path and enqueues the job', async () => {
    (createAudioSeparationJob as jest.Mock).mockResolvedValue({
      created: true,
      row: { id: JOB_ID, status: 'pending', cost_credits: 2 },
    });
    (audioSeparationQueue.add as jest.Mock).mockResolvedValue(undefined);
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ job_id: JOB_ID, status: 'pending', cost_credits: 2 });
    expect(audioSeparationQueue.add).toHaveBeenCalledWith('separate', { jobId: JOB_ID }, { jobId: JOB_ID });
  });

  it('refunds and returns 503 when queue.add throws (dispatch-after-deduct failure)', async () => {
    (createAudioSeparationJob as jest.Mock).mockResolvedValue({
      created: true,
      row: { id: JOB_ID, status: 'pending', cost_credits: 2 },
    });
    (audioSeparationQueue.add as jest.Mock).mockRejectedValue(new Error('redis down'));
    (refundAudioSeparation as jest.Mock).mockResolvedValue(true);
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(503);
    expect(refundAudioSeparation).toHaveBeenCalledWith(JOB_ID, 'queue_unavailable', expect.any(String));
  });

  it('returns 503 when audioSepEnabled is false', async () => {
    const configModule = jest.requireMock('../../config') as { config: { audioSepEnabled: boolean } };
    configModule.config.audioSepEnabled = false;
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app)
      .post(`/api/clips/${CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'key-1')
      .send({ prompt: 'background music' });
    expect(res.status).toBe(503);
    configModule.config.audioSepEnabled = true;
  });
});

describe('GET /clips/:clipId/audio-separations/:jobId', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = buildApp(null);
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separations/${JOB_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a job owned by a different user (IDOR guard)', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue({
      id: JOB_ID, user_id: 'someone-else', source_clip_id: CLIP_ID, status: 'completed',
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separations/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a nonexistent job', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue(null);
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separations/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns the status payload including source_prior_volume, and no URL field', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      user_id: USER_ID,
      source_clip_id: CLIP_ID,
      status: 'completed',
      cost_credits: 2,
      target_audio_clip_id: 'target-clip-id',
      residual_audio_clip_id: 'residual-clip-id',
      failure_code: null,
      source_prior_volume: 0.7,
      target_r2_key: 'audio-separation/x/target.mp3',
      residual_r2_key: 'audio-separation/x/residual.mp3',
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });
    const res = await request(app).get(`/api/clips/${CLIP_ID}/audio-separations/${JOB_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'completed',
      cost_credits: 2,
      target_audio_clip_id: 'target-clip-id',
      residual_audio_clip_id: 'residual-clip-id',
      failure_code: null,
      source_prior_volume: 0.7,
    });
    expect(res.body.target_r2_key).toBeUndefined();
    expect(res.body.residual_r2_key).toBeUndefined();
  });
});

// ─── Chained separation (source is a stem, not a clip) ────────────────────────

describe('POST /audio-clips/:audioClipId/audio-separations', () => {
  it('starts a job against the stem and enqueues it', async () => {
    (createAudioSeparationJob as jest.Mock).mockResolvedValue({
      row: { id: JOB_ID, status: 'pending', cost_credits: 2 }, created: true,
    });
    // An earlier test installs a persistent mockRejectedValue on queue.add and jest.clearAllMocks()
    // only clears calls, not implementations — so the happy path must re-arm it explicitly.
    (audioSeparationQueue.add as jest.Mock).mockResolvedValue(undefined);
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'idem-chain-1')
      .send({ prompt: 'drums' });

    expect(res.status).toBe(202);
    // The service must receive audioClipId — never clipId — or the job would resolve the wrong source.
    expect(createAudioSeparationJob).toHaveBeenCalledWith({
      userId: USER_ID, audioClipId: AUDIO_CLIP_ID, prompt: 'drums', idempotencyKey: 'idem-chain-1',
    });
    expect(audioSeparationQueue.add).toHaveBeenCalledWith('separate', { jobId: JOB_ID }, { jobId: JOB_ID });
  });

  it('404s a stem owned by someone else (no existence leak)', async () => {
    (createAudioSeparationJob as jest.Mock).mockRejectedValue(new AudioSeparationNotFoundError());
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'idem-chain-2')
      .send({ prompt: 'drums' });

    expect(res.status).toBe(404);
  });

  it('enforces the same rate limit / credit / idempotency contract as the clip route', async () => {
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    (checkDailyRateLimit as jest.Mock).mockRejectedValueOnce(new SeparationRateLimitedError());
    const limited = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'k').send({ prompt: 'drums' });
    expect(limited.status).toBe(429);

    (createAudioSeparationJob as jest.Mock).mockRejectedValueOnce(new InsufficientSeparationCreditsError());
    const broke = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'k').send({ prompt: 'drums' });
    expect(broke.status).toBe(402);

    const noKey = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`).send({ prompt: 'drums' });
    expect(noKey.status).toBe(400);

    const noPrompt = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'k').send({});
    expect(noPrompt.status).toBe(400);
  });

  it('refunds and 503s when the queue is unavailable', async () => {
    (createAudioSeparationJob as jest.Mock).mockResolvedValue({
      row: { id: JOB_ID, status: 'pending', cost_credits: 2 }, created: true,
    });
    (audioSeparationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app)
      .post(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations`)
      .set('Idempotency-Key', 'idem-chain-3')
      .send({ prompt: 'drums' });

    expect(res.status).toBe(503);
    expect(refundAudioSeparation).toHaveBeenCalledWith(JOB_ID, 'queue_unavailable', expect.any(String));
  });
});

describe('GET /audio-clips/:audioClipId/audio-separation/quote', () => {
  it('quotes against the stem', async () => {
    (quoteAudioClipSeparation as jest.Mock).mockResolvedValue({
      supported: true, duration_seconds: 6, cost_credits: 1,
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app).get(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separation/quote`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supported: true, duration_seconds: 6, cost_credits: 1, enabled: true });
    expect(quoteAudioClipSeparation).toHaveBeenCalledWith(AUDIO_CLIP_ID, USER_ID);
  });
});

describe('GET /audio-clips/:audioClipId/audio-separations/:jobId', () => {
  it('returns undo state for a stem source (enabled/gain, not clip volume)', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue({
      user_id: USER_ID,
      source_clip_id: null,
      source_audio_clip_id: AUDIO_CLIP_ID,
      status: 'completed',
      cost_credits: 1,
      target_audio_clip_id: 't', residual_audio_clip_id: 'r',
      failure_code: null,
      source_prior_volume: null,
      source_prior_enabled: true,
      source_prior_gain: 0.8,
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app).get(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source_prior_enabled: true, source_prior_gain: 0.8 });
  });

  it('404s when the job belongs to a different stem (IDOR guard on the chained route)', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue({
      user_id: USER_ID,
      source_clip_id: null,
      source_audio_clip_id: 'some-other-stem',
      status: 'completed', cost_credits: 1,
      target_audio_clip_id: null, residual_audio_clip_id: null,
      failure_code: null, source_prior_volume: null,
      source_prior_enabled: null, source_prior_gain: null,
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app).get(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations/${JOB_ID}`);

    expect(res.status).toBe(404);
  });

  it('404s a clip-sourced job requested through the stem route', async () => {
    (getAudioSeparationJob as jest.Mock).mockResolvedValue({
      user_id: USER_ID,
      source_clip_id: CLIP_ID,
      source_audio_clip_id: null,
      status: 'completed', cost_credits: 1,
      target_audio_clip_id: null, residual_audio_clip_id: null,
      failure_code: null, source_prior_volume: 1,
      source_prior_enabled: null, source_prior_gain: null,
    });
    const app = buildApp({ uid: 'fb-1', dbUserId: USER_ID });

    const res = await request(app).get(`/api/audio-clips/${AUDIO_CLIP_ID}/audio-separations/${JOB_ID}`);

    expect(res.status).toBe(404);
  });
});
