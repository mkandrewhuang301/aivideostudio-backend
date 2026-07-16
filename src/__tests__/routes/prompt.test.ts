// src/__tests__/routes/prompt.test.ts
// Integration tests for POST /api/prompt/enhance and /api/prompt/from-image.
// Covers auth, input validation, IDOR/ownership, media-type gating, per-preset instruction
// resolution, hint moderation, and the fail-loud 502 mapping.

// Mock config FIRST — config.ts calls requireEnv() at module eval time
jest.mock('../../config', () => ({
  config: {
    openaiApiKey: 'test-openai-key',
    databaseUrl: 'mock://db',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
    nodeEnv: 'test',
  },
}));

// db/client must be mocked — neon() throws at module eval with a non-postgres URL
jest.mock('../../db/client', () => ({
  db: { select: jest.fn() },
}));

jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/generations/signed.jpg'),
  getUploadPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/uploads/signed.jpg'),
}));

// Real PromptIntelligenceError identity (route does instanceof), mocked entry points.
jest.mock('../../services/promptIntelligenceService', () => {
  const actual = jest.requireActual('../../services/promptIntelligenceService');
  return { ...actual, enhancePrompt: jest.fn(), promptFromImage: jest.fn() };
});

jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isPromptFlagged: jest.fn().mockResolvedValue(false),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { promptRouter } from '../../routes/prompt';
import { db } from '../../db/client';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../../services/archivalService';
import { enhancePrompt, promptFromImage, PromptIntelligenceError } from '../../services/promptIntelligenceService';
import { isPromptFlagged } from '../../middleware/promptModeration';
import { SERVER_PRESETS } from '../../config/presets';

const dbMock = db as unknown as { select: jest.Mock };
const enhanceMock = enhancePrompt as jest.Mock;
const fromImageMock = promptFromImage as jest.Mock;
const flaggedMock = isPromptFlagged as jest.Mock;
const genPresignMock = getGenerationPresignedUrl as jest.Mock;
const uploadPresignMock = getUploadPresignedUrl as jest.Mock;

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-db-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});
app.use('/api/prompt', promptRouter);

const unauthApp = express();
unauthApp.use(express.json());
unauthApp.use('/api/prompt', promptRouter);

function makeSelectChain(rows: unknown[] = []) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

const GEN_ID = '11111111-2222-3333-4444-555555555555';
const UPLOAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const completedImageGen = {
  id: GEN_ID,
  user_id: 'test-db-user-id',
  status: 'completed',
  media_type: 'image',
  r2_key: 'generations/test/img.jpg',
};

beforeEach(() => {
  jest.clearAllMocks();
  flaggedMock.mockResolvedValue(false);
  genPresignMock.mockResolvedValue('https://r2.example.com/generations/signed.jpg');
  uploadPresignMock.mockResolvedValue('https://r2.example.com/uploads/signed.jpg');
});

describe('POST /api/prompt/enhance', () => {
  it('401s without an authenticated user', async () => {
    const res = await request(unauthApp).post('/api/prompt/enhance').send({ prompt: 'a dog' });
    expect(res.status).toBe(401);
  });

  it('400s on a missing/empty prompt', async () => {
    const res = await request(app).post('/api/prompt/enhance').send({ prompt: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROMPT');
  });

  it('400s on an invalid mode', async () => {
    const res = await request(app).post('/api/prompt/enhance').send({ prompt: 'a dog', mode: 'poem' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  it('400s on an unknown preset_id', async () => {
    const res = await request(app).post('/api/prompt/enhance').send({ prompt: 'a dog', preset_id: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRESET');
  });

  it('returns the improved prompt on success', async () => {
    enhanceMock.mockResolvedValue('A cinematic dog.');
    const res = await request(app).post('/api/prompt/enhance').send({ prompt: '  a dog  ', mode: 'script' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prompt: 'A cinematic dog.' });
    expect(enhanceMock).toHaveBeenCalledWith({ prompt: 'a dog', mode: 'script', instruction: undefined });
  });

  it('passes the per-preset enhance instruction when the preset defines one', async () => {
    const preset = SERVER_PRESETS.find((p) => p.prompt_intelligence?.enhance)
      ?? SERVER_PRESETS.find((p) => p.prompt_intelligence);
    // Registry currently ships a from_image example only — enhance falls back to undefined,
    // which is exactly what this asserts (instruction resolution, not registry contents).
    enhanceMock.mockResolvedValue('x');
    const res = await request(app)
      .post('/api/prompt/enhance')
      .send({ prompt: 'a dog', preset_id: preset!.preset_id });
    expect(res.status).toBe(200);
    expect(enhanceMock).toHaveBeenCalledWith({
      prompt: 'a dog',
      mode: 'prompt',
      instruction: preset!.prompt_intelligence?.enhance?.instruction,
    });
  });

  it('502s with llm_unavailable when the LLM fails', async () => {
    enhanceMock.mockRejectedValue(new PromptIntelligenceError('down'));
    const res = await request(app).post('/api/prompt/enhance').send({ prompt: 'a dog' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('llm_unavailable');
  });
});

describe('POST /api/prompt/from-image', () => {
  it('401s without an authenticated user', async () => {
    const res = await request(unauthApp).post('/api/prompt/from-image').send({ generation_id: GEN_ID });
    expect(res.status).toBe(401);
  });

  it('400s when neither or both of generation_id/upload_id are provided', async () => {
    const neither = await request(app).post('/api/prompt/from-image').send({});
    expect(neither.status).toBe(400);
    const both = await request(app)
      .post('/api/prompt/from-image')
      .send({ generation_id: GEN_ID, upload_id: UPLOAD_ID });
    expect(both.status).toBe(400);
  });

  it('400s on an over-long hint', async () => {
    const res = await request(app)
      .post('/api/prompt/from-image')
      .send({ generation_id: GEN_ID, hint: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('400s with content_policy_violation on a flagged hint', async () => {
    flaggedMock.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/prompt/from-image')
      .send({ generation_id: GEN_ID, hint: 'bad hint' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('content_policy_violation');
    expect(fromImageMock).not.toHaveBeenCalled();
  });

  it('404s on a malformed generation_id without touching the db', async () => {
    const res = await request(app).post('/api/prompt/from-image').send({ generation_id: 'not-a-uuid' });
    expect(res.status).toBe(404);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("404s when the generation doesn't exist or belongs to another user", async () => {
    dbMock.select.mockReturnValue(makeSelectChain([]));
    const res = await request(app).post('/api/prompt/from-image').send({ generation_id: GEN_ID });
    expect(res.status).toBe(404);
  });

  it('409s when the generation is not completed', async () => {
    dbMock.select.mockReturnValue(makeSelectChain([{ ...completedImageGen, status: 'processing', r2_key: null }]));
    const res = await request(app).post('/api/prompt/from-image').send({ generation_id: GEN_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_READY');
  });

  it('400s when the generation is a video, not an image', async () => {
    dbMock.select.mockReturnValue(makeSelectChain([{ ...completedImageGen, media_type: 'video' }]));
    const res = await request(app).post('/api/prompt/from-image').send({ generation_id: GEN_ID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_AN_IMAGE');
  });

  it('presigns the generation r2_key server-side and returns the tailored prompt', async () => {
    dbMock.select.mockReturnValue(makeSelectChain([completedImageGen]));
    fromImageMock.mockResolvedValue('Tailored motion prompt.');
    const res = await request(app)
      .post('/api/prompt/from-image')
      .send({ generation_id: GEN_ID, hint: 'make it rainy' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ prompt: 'Tailored motion prompt.' });
    expect(genPresignMock).toHaveBeenCalledWith('generations/test/img.jpg');
    expect(fromImageMock).toHaveBeenCalledWith({
      imageUrl: 'https://r2.example.com/generations/signed.jpg',
      instruction: undefined,
      hint: 'make it rainy',
    });
  });

  it('resolves the per-preset from_image instruction (animate-old-photo worked example)', async () => {
    const preset = SERVER_PRESETS.find((p) => p.preset_id === 'animate-old-photo');
    expect(preset?.prompt_intelligence?.from_image?.instruction).toBeTruthy();

    dbMock.select.mockReturnValue(makeSelectChain([completedImageGen]));
    fromImageMock.mockResolvedValue('x');
    const res = await request(app)
      .post('/api/prompt/from-image')
      .send({ generation_id: GEN_ID, preset_id: 'animate-old-photo' });
    expect(res.status).toBe(200);
    expect(fromImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: preset!.prompt_intelligence!.from_image!.instruction }),
    );
  });

  it('handles the upload path and rejects non-image uploads', async () => {
    dbMock.select.mockReturnValue(
      makeSelectChain([{ id: UPLOAD_ID, user_id: 'test-db-user-id', r2_key: 'uploads/u/ref.mp4', mime_type: 'video/mp4' }]),
    );
    const rejected = await request(app).post('/api/prompt/from-image').send({ upload_id: UPLOAD_ID });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('NOT_AN_IMAGE');

    dbMock.select.mockReturnValue(
      makeSelectChain([{ id: UPLOAD_ID, user_id: 'test-db-user-id', r2_key: 'uploads/u/ref.jpg', mime_type: 'image/jpeg' }]),
    );
    fromImageMock.mockResolvedValue('Upload prompt.');
    const ok = await request(app).post('/api/prompt/from-image').send({ upload_id: UPLOAD_ID });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ prompt: 'Upload prompt.' });
    expect(uploadPresignMock).toHaveBeenCalledWith('uploads/u/ref.jpg');
  });

  it('502s with llm_unavailable when the vision call fails', async () => {
    dbMock.select.mockReturnValue(makeSelectChain([completedImageGen]));
    fromImageMock.mockRejectedValue(new PromptIntelligenceError('down'));
    const res = await request(app).post('/api/prompt/from-image').send({ generation_id: GEN_ID });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('llm_unavailable');
  });
});
