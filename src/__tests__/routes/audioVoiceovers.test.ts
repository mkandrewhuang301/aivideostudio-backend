jest.mock('../../config', () => ({
  config: {},
}));
jest.mock('../../services/voiceoverService', () => ({
  ...jest.requireActual('../../services/voiceoverService'),
  getVoiceoverQuote: jest.fn(),
  createVoiceoverGeneration: jest.fn(),
  getVoiceover: jest.fn(),
  refundVoiceover: jest.fn(),
}));
jest.mock('../../queue/voiceoverGenerationQueue', () => ({
  voiceoverGenerationQueue: { add: jest.fn() },
}));
jest.mock('../../db/client', () => ({
  db: {
    select: jest.fn(),
    execute: jest.fn(),
    batch: jest.fn(),
  },
}));
jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn().mockResolvedValue({}) },
  R2_BUCKET: 'test-bucket',
}));
jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: jest.fn().mockResolvedValue('https://signed.example/audio.m4a'),
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { audioVoiceoversRouter } from '../../routes/audioVoiceovers';
import {
  getVoiceoverQuote,
  createVoiceoverGeneration,
  getVoiceover,
  refundVoiceover,
  attachVoiceoverToProject,
  VoiceoverNotFoundError,
  VoiceoverValidationError,
  InsufficientVoiceoverCreditsError,
} from '../../services/voiceoverService';
import { voiceoverGenerationQueue } from '../../queue/voiceoverGenerationQueue';
import { db } from '../../db/client';
import { r2 } from '../../storage/r2';

const quoteMock = getVoiceoverQuote as unknown as jest.Mock;
const createMock = createVoiceoverGeneration as unknown as jest.Mock;
const getMock = getVoiceover as unknown as jest.Mock;
const refundMock = refundVoiceover as unknown as jest.Mock;
const queueMock = voiceoverGenerationQueue.add as unknown as jest.Mock;
const dbMock = db as unknown as {
  select: jest.Mock;
  execute: jest.Mock;
  batch: jest.Mock;
};
const r2Mock = r2 as unknown as { send: jest.Mock };

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

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'for']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  (chain as { then: PromiseLike<unknown>['then'] }).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
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
  r2Mock.send.mockResolvedValue({});
  dbMock.select.mockReturnValue(makeChain([]));
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
    expect(queueMock).toHaveBeenCalledWith('generate', { voiceoverId: baseRow.id }, { jobId: `voiceover-${baseRow.id}` });
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

describe('POST /api/projects/:projectId/voiceovers/:voiceoverId/attach', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(null))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 5 });

    expect(res.status).toBe(401);
  });

  it('returns 400 when start_offset_seconds is negative', async () => {
    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: -1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when start_offset_seconds is not finite', async () => {
    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 'now' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the voiceover cannot be attached', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([]));

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 5 });

    expect(res.status).toBe(404);
  });

  it('attaches a succeeded voiceover to the project at the requested offset', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{
        id: 'voiceover-1',
        final_r2_key: 'voiceovers/final/user-1/voiceover-1.m4a',
        attached_audio_clip_id: null,
        duration_seconds: 6,
      }]))
      .mockReturnValueOnce(makeChain([{
        id: 'audio-clip-1',
        project_id: 'project-1',
        r2_key: 'projects/project-1/audio/audio-clip-1.m4a',
        source_type: 'narration',
        display_name: 'AI Voiceover',
        start_offset_seconds: 5.5,
        trim_start_seconds: 0,
        trim_end_seconds: 6,
        original_duration_seconds: 6,
        sort_order: 0,
        created_at: new Date().toISOString(),
      }]));
    dbMock.execute.mockResolvedValueOnce({
      rows: [{
        existing_clip_id: null,
        inserted_clip_id: 'audio-clip-1',
        updated_clip_id: 'audio-clip-1',
      }],
    });

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 5.5 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      audio_clip_id: 'audio-clip-1',
      url: expect.stringContaining('https://signed.example/'),
    });
    expect(JSON.stringify(res.body)).not.toContain('voiceovers/raw/');
    expect(JSON.stringify(res.body)).not.toContain('voiceovers/final/');
    expect(r2Mock.send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
  });

  it('returns the existing clip on repeated attach without copying again', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{
        id: 'voiceover-1',
        final_r2_key: 'voiceovers/final/user-1/voiceover-1.m4a',
        attached_audio_clip_id: 'audio-clip-1',
        duration_seconds: 6,
      }]))
      .mockReturnValueOnce(makeChain([{
        id: 'audio-clip-1',
        project_id: 'project-1',
        r2_key: 'projects/project-1/audio/audio-clip-1.m4a',
        source_type: 'narration',
        display_name: 'AI Voiceover',
        start_offset_seconds: 5.5,
        trim_start_seconds: 0,
        trim_end_seconds: 6,
        original_duration_seconds: 6,
        sort_order: 0,
        created_at: new Date().toISOString(),
      }]));

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 5.5 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ audio_clip_id: 'audio-clip-1' });
    expect(r2Mock.send).not.toHaveBeenCalled();
  });

  it('returns the shared 400 capacity error when the project is full', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{
      id: 'voiceover-1',
      final_r2_key: 'voiceovers/final/user-1/voiceover-1.m4a',
      attached_audio_clip_id: null,
      duration_seconds: 6,
    }]));
    dbMock.execute.mockResolvedValueOnce({
      rows: [{
        existing_clip_id: null,
        inserted_clip_id: null,
        updated_clip_id: null,
      }],
    });

    const res = await request(buildApp(AUTHED_USER))
      .post('/api/projects/project-1/voiceovers/voiceover-1/attach')
      .send({ start_offset_seconds: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum of 10 audio clips/i);
    expect(r2Mock.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });
});

describe('attachVoiceoverToProject service', () => {
  it('copies the final M4A before running the atomic attach statement', async () => {
    dbMock.select
      .mockReturnValueOnce(makeChain([{
        id: 'voiceover-1',
        final_r2_key: 'voiceovers/final/user-1/voiceover-1.m4a',
        attached_audio_clip_id: null,
        duration_seconds: 6,
      }]))
      .mockReturnValueOnce(makeChain([{
        id: 'audio-clip-1',
        project_id: 'project-1',
        r2_key: 'projects/project-1/audio/audio-clip-1.m4a',
        source_type: 'narration',
        display_name: 'AI Voiceover',
        start_offset_seconds: 3,
        trim_start_seconds: 0,
        trim_end_seconds: 6,
        original_duration_seconds: 6,
        sort_order: 0,
        created_at: new Date().toISOString(),
      }]));
    dbMock.execute.mockResolvedValueOnce({
      rows: [{
        existing_clip_id: null,
        inserted_clip_id: 'audio-clip-1',
        updated_clip_id: 'audio-clip-1',
      }],
    });

    const result = await attachVoiceoverToProject({
      projectId: 'project-1',
      voiceoverId: 'voiceover-1',
      userId: AUTHED_USER.dbUserId,
      startOffsetSeconds: 3,
    });

    expect(r2Mock.send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
    expect(result).toMatchObject({ audio_clip_id: 'audio-clip-1' });
  });

  it('deletes the copied object on capacity failure', async () => {
    dbMock.select.mockReturnValueOnce(makeChain([{
      id: 'voiceover-1',
      final_r2_key: 'voiceovers/final/user-1/voiceover-1.m4a',
      attached_audio_clip_id: null,
      duration_seconds: 6,
    }]));
    dbMock.execute.mockResolvedValueOnce({
      rows: [{
        existing_clip_id: null,
        inserted_clip_id: null,
        updated_clip_id: null,
      }],
    });

    await expect(attachVoiceoverToProject({
      projectId: 'project-1',
      voiceoverId: 'voiceover-1',
      userId: AUTHED_USER.dbUserId,
      startOffsetSeconds: 0,
    })).rejects.toThrow(/maximum of 10 audio clips/i);

    expect(r2Mock.send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });
});
