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
  refundAudioSeparation,
} from '../../services/audioSeparationService';

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
