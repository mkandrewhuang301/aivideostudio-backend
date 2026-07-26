jest.mock('../../config', () => ({
  config: {},
}));
jest.mock('../../services/voiceoverService', () => ({
  getVoiceoverQuote: jest.fn(),
  createVoiceoverGeneration: jest.fn(),
  getVoiceover: jest.fn(),
  refundVoiceover: jest.fn(),
  VoiceoverNotFoundError: class VoiceoverNotFoundError extends Error {},
  VoiceoverValidationError: class VoiceoverValidationError extends Error {},
  InsufficientVoiceoverCreditsError: class InsufficientVoiceoverCreditsError extends Error {},
}));
jest.mock('../../queue/voiceoverGenerationQueue', () => ({
  voiceoverGenerationQueue: { add: jest.fn() },
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { audioVoiceoversRouter } from '../../routes/audioVoiceovers';
import {
  getVoiceoverQuote,
  createVoiceoverGeneration,
  getVoiceover,
  refundVoiceover,
  VoiceoverNotFoundError,
  VoiceoverValidationError,
  InsufficientVoiceoverCreditsError,
} from '../../services/voiceoverService';
import { voiceoverGenerationQueue } from '../../queue/voiceoverGenerationQueue';

const quoteMock = getVoiceoverQuote as unknown as jest.Mock;
const createMock = createVoiceoverGeneration as unknown as jest.Mock;
const getMock = getVoiceover as unknown as jest.Mock;
const refundMock = refundVoiceover as unknown as jest.Mock;
const queueMock = voiceoverGenerationQueue.add as unknown as jest.Mock;

const AUTHED_USER = { uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' };

function buildApp(user: { uid: string; dbUserId: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', audioVoiceoversRouter);
  return app;
}

const baseRow = {
  id: 'voiceover-1',
  project_id: 'project-1',
  user_id: AUTHED_USER.dbUserId,
  status: 'pending',
  voice_id: 'kore',
  script: 'Hello world.',
  cost_credits: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/projects/:projectId/voiceover/quote', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(null))
      .post('/api/projects/project-1/voiceover/quote')
      .send({ voice_id: 'kore', script: 'Hello.' });

    expect(res.status).toBe(401);
  });

  it('returns the quote for a valid request', async () => {
    quoteMock.mockResolvedValueOnce({
      voice_id: 'kore',
      script_preview: 'Hello.',
      cost_credits: 1,
      estimated_provider_cents: 0.003,
      pricing_version: '2026-07-26a',
    });

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceover/quote')
      .send({ voice_id: 'kore', script: 'Hello.' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      voice_id: 'kore',
      cost_credits: 1,
      estimated_provider_cents: 0.003,
    });
  });

  it('returns 404 when the project is not owned', async () => {
    quoteMock.mockResolvedValueOnce(null);

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceover/quote')
      .send({ voice_id: 'kore', script: 'Hello.' });

    expect(res.status).toBe(404);
  });

  it('maps validation errors to 422', async () => {
    quoteMock.mockRejectedValueOnce(new VoiceoverValidationError('Script too long'));

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceover/quote')
      .send({ voice_id: 'kore', script: 'a'.repeat(5001) });

    expect(res.status).toBe(422);
  });
});

describe('POST /api/projects/:projectId/voiceovers', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(null))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(401);
  });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/i);
  });

  it('creates, enqueues, and returns a safe projection', async () => {
    createMock.mockResolvedValueOnce({ row: baseRow, created: true });
    queueMock.mockResolvedValueOnce(undefined);

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello world.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      voiceover_id: baseRow.id,
      status: 'pending',
      cost_credits: 1,
    });
    expect(queueMock).toHaveBeenCalledWith('generate', { voiceoverId: baseRow.id }, { jobId: baseRow.id });
    expect(JSON.stringify(res.body)).not.toContain('provider');
    expect(JSON.stringify(res.body)).not.toContain('final_r2_key');
  });

  it('does not enqueue when the idempotency key returns an existing row', async () => {
    createMock.mockResolvedValueOnce({ row: baseRow, created: false });

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello world.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(202);
    expect(queueMock).not.toHaveBeenCalled();
  });

  it('refunds and returns 503 when queue enqueue fails', async () => {
    createMock.mockResolvedValueOnce({ row: baseRow, created: true });
    queueMock.mockRejectedValueOnce(new Error('Redis down'));
    refundMock.mockResolvedValueOnce(true);

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello world.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(503);
    expect(refundMock).toHaveBeenCalledWith(baseRow.id, 'queue_unavailable', expect.any(String));
  });

  it('maps validation errors to 422', async () => {
    createMock.mockRejectedValueOnce(new VoiceoverValidationError('Invalid voice'));

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'stale', script: 'Hello.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(422);
  });

  it('returns 402 for insufficient credits', async () => {
    createMock.mockRejectedValueOnce(new InsufficientVoiceoverCreditsError());

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(402);
  });

  it('returns 404 for a missing project', async () => {
    createMock.mockRejectedValueOnce(new VoiceoverNotFoundError());

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers')
      .send({ voice_id: 'kore', script: 'Hello.' })
      .set('Idempotency-Key', 'key-1');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:projectId/voiceovers/:voiceoverId', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(null))
      .get('/api/projects/project-1/voiceovers/voiceover-1');

    expect(res.status).toBe(401);
  });

  it('returns the safe projection for an owned voiceover', async () => {
    getMock.mockResolvedValueOnce({
      voiceover_id: 'voiceover-1',
      status: 'succeeded',
      audio_url: 'https://signed.example/audio.wav',
      cost_credits: 1,
    });

    const res = await request(buildApp(AUTHED_USER))
      .get('/api/projects/project-1/voiceovers/voiceover-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      voiceover_id: 'voiceover-1',
      status: 'succeeded',
    });
  });

  it('returns 404 for a missing voiceover', async () => {
    getMock.mockResolvedValueOnce(null);

    const res = await request(buildApp(AUTHED_USER))
      .get('/api/projects/project-1/voiceovers/voiceover-1');

    expect(res.status).toBe(404);
  });
});
