jest.mock('../../config', () => ({ config: {} }));

const mockGetUploadPresignedUrl = jest.fn();
jest.mock('../../services/archivalService', () => ({
  getUploadPresignedUrl: mockGetUploadPresignedUrl,
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { audioVoicesRouter } from '../../routes/audioVoices';
import { AUDIO_VOICES_VERSION, CLIENT_AUDIO_VOICES } from '../../config/audioVoices';

function buildApp(user: { uid: string; dbUserId: string } | null) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/audio-voices', audioVoicesRouter);
  return app;
}

const AUTHED_USER = { uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' };

describe('GET /api/audio-voices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUploadPresignedUrl.mockImplementation((key: string) =>
      Promise.resolve(`https://signed.example/${key}`),
    );
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(null)).get('/api/audio-voices');
    expect(res.status).toBe(401);
  });

  it('returns the versioned roster with signed previews for an authenticated user', async () => {
    const res = await request(buildApp(AUTHED_USER)).get('/api/audio-voices');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(AUDIO_VOICES_VERSION);
    expect(Array.isArray(res.body.voices)).toBe(true);
    expect(res.body.voices.length).toBe(CLIENT_AUDIO_VOICES.length);

    for (const voice of res.body.voices) {
      expect(voice.previewUrl).toMatch(/^https:\/\/signed\.example\//);
    }
  });

  it('never exposes private provider or clone fields', async () => {
    const res = await request(buildApp(AUTHED_USER)).get('/api/audio-voices');
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain('referenceR2Key');
    expect(serialized).not.toContain('referenceText');
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('model');
    expect(serialized).not.toContain('speaker');
    expect(serialized).not.toContain('transcript');
  });

  it('includes Kore and voiceA in the roster', async () => {
    const res = await request(buildApp(AUTHED_USER)).get('/api/audio-voices');
    const ids = res.body.voices.map((v: { id: string }) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['kore', 'voiceA']));
  });

  it('does not label the cloned voice as My Voice', async () => {
    const res = await request(buildApp(AUTHED_USER)).get('/api/audio-voices');
    const voiceA = res.body.voices.find((v: { id: string }) => v.id === 'voiceA');
    expect(voiceA).toBeDefined();
    expect(voiceA.label.toLowerCase()).not.toContain('my voice');
  });
});
