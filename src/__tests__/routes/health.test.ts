// src/__tests__/routes/health.test.ts
import express from 'express';
import request from 'supertest';

const mockExecute = jest.fn();
const mockPing = jest.fn();
const mockSend = jest.fn();
const mockGetJobCounts = jest.fn();

jest.mock('../../db/client', () => ({
  db: { execute: mockExecute },
}));

jest.mock('../../redis/client', () => ({
  redis: { ping: mockPing },
}));

jest.mock('../../storage/r2', () => ({
  r2: { send: mockSend },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('../../queue/voiceoverGenerationQueue', () => ({
  voiceoverGenerationQueue: {
    getJobCounts: mockGetJobCounts,
  },
}));

import { healthRouter } from '../../routes/health';

function buildApp() {
  const app = express();
  app.use('/api/health', healthRouter);
  return app;
}

describe('GET /api/health', () => {
  const originalCommitSha = process.env.RAILWAY_GIT_COMMIT_SHA;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
    mockPing.mockResolvedValue('PONG');
    mockSend.mockResolvedValue({});
    mockGetJobCounts.mockResolvedValue({ waiting: 1, active: 2, completed: 3, failed: 0 });
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  afterAll(() => {
    if (originalCommitSha !== undefined) {
      process.env.RAILWAY_GIT_COMMIT_SHA = originalCommitSha;
    } else {
      delete process.env.RAILWAY_GIT_COMMIT_SHA;
    }
  });

  it('returns 200 when all core checks pass and includes voiceover queue evidence', async () => {
    const res = await request(buildApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toMatchObject({
      postgres: 'ok',
      redis: 'ok',
      r2: 'ok',
    });
    expect(res.body.voiceoverQueue).toEqual({
      status: 'ok',
      counts: { waiting: 1, active: 2, completed: 3, failed: 0 },
    });
    expect(res.body.version).toBe('unknown');
  });

  it('returns 503 when a core check fails', async () => {
    mockExecute.mockRejectedValue(new Error('postgres down'));

    const res = await request(buildApp()).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.postgres).toBe('error');
    expect(res.body.checks.redis).toBe('ok');
    expect(res.body.checks.r2).toBe('ok');
  });

  it('keeps voiceover queue failure out of the allOk aggregation', async () => {
    mockGetJobCounts.mockRejectedValue(new Error('redis unreachable'));

    const res = await request(buildApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.voiceoverQueue).toEqual({ status: 'error' });
  });

  it('includes the short git commit sha as version when available', async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';

    const res = await request(buildApp()).get('/api/health');

    expect(res.body.version).toBe('abcdef1');
  });
});
