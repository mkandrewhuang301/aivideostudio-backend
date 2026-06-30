// src/__tests__/routes/generations.test.ts
// Integration tests for POST /api/generations.
// Covers SC-1 (dispatch success), SC-5 (zero-credit rejection before any Replicate call),
// duration validation before credit gate, and 'auto' duration resolution never forwarding -1.

// Mock config FIRST — before any module that calls requireEnv() at load time
jest.mock('../../config', () => ({
  config: {
    revenueCatWebhookSecret: 'test-webhook-secret',
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'mock',
    r2PublicDomain: '',
    firebaseProjectId: 'mock',
    firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key',
    apnsAuthKey: 'mock-key',
    apnsKeyId: 'mock',
    apnsTeamId: 'mock',
    apnsBundleId: 'mock',
    replicateApiToken: 'mock-token',
    replicateWebhookSecret: 'whsec_mock',
    publicBaseUrl: 'https://mock.example.com',
    port: 3000,
    nodeEnv: 'test',
  },
}));

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
  },
}));

jest.mock('../../services/creditService', () => ({
  deductCredits: jest.fn(),
  refundCredits: jest.fn(),
}));

jest.mock('../../services/generationService', () => ({
  resolveDurationSeconds: jest.fn(),
  computeCostCredits: jest.fn(),
  computeImageCostCredits: jest.fn(),
  createGeneration: jest.fn(),
  attachPredictionId: jest.fn(),
  markRefunded: jest.fn(),
  markFailed: jest.fn(),
  listGenerations: jest.fn(),
  getGenerationById: jest.fn(),
  softDeleteGeneration: jest.fn(),
  SUPPORTED_MODELS: ['bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0'],
  MODEL_RESOLUTIONS: {
    'bytedance/seedance-2.0-fast': ['480p', '720p'],
    'bytedance/seedance-2.0-mini': ['480p', '720p'],
    'bytedance/seedance-2.0':      ['480p', '720p', '1080p', '4k'],
  },
  SUPPORTED_IMAGE_MODELS: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-dev'],
}));

jest.mock('../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
  getGenerationPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned'),
  getUploadPresignedUrl: jest.fn(),
}));

jest.mock('../../services/providers/ReplicateProvider', () => {
  return {
    ReplicateProvider: jest.fn().mockImplementation(() => ({
      dispatch: jest.fn(),
    })),
  };
});

// Mock promptModerationMiddleware as a pass-through — moderation logic is tested separately
// in src/__tests__/middleware/promptModeration.test.ts
jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { generationsRouter } from '../../routes/generations';
import { deductCredits, refundCredits } from '../../services/creditService';
import {
  resolveDurationSeconds,
  computeCostCredits,
  computeImageCostCredits,
  createGeneration,
  attachPredictionId,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
  markRefunded,
  markFailed,
} from '../../services/generationService';
import { getGenerationPresignedUrl } from '../../services/archivalService';
import { ReplicateProvider } from '../../services/providers/ReplicateProvider';

// Grab the mocked dispatch fn off the mocked class's first (and only) instance used by the router.
// generationsRouter does `const provider = new ReplicateProvider();` at module load time,
// so the mock constructor was already invoked once; pull the instance's dispatch mock from
// the mock's `.mock.results`.
const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

const app = express();
app.use(express.json());

// Fake auth-injecting middleware mirroring authMiddleware's effect on req.user
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});

app.use('/api/generations', generationsRouter);

const VALID_BODY = {
  prompt: 'a cinematic shot of a city at night',
  duration: 8,
  resolution: '720p' as const,
  aspect_ratio: '16:9',
  audio_enabled: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/generations', () => {
  it('Test 1: dispatches and returns 200 with generation_id + processing on success', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-123' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-abc' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-123', status: 'processing' });

    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 60 }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 60);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(attachPredictionId).toHaveBeenCalledWith('gen-123', 'pred-abc');
  });

  it('Test 2: insufficient credits returns 402 and never calls ReplicateProvider.dispatch', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('Test 3: out-of-range duration returns 400 before credit deduction is attempted', async () => {
    (resolveDurationSeconds as jest.Mock).mockImplementation(() => {
      throw new Error('duration must be an integer between 4 and 15 seconds');
    });

    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, duration: 20 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("Test 4: duration 'auto' resolves to explicit seconds, never -1, in DB insert and dispatch input", async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(38);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-456' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-def' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, duration: 'auto' });

    expect(res.status).toBe(200);
    expect(resolveDurationSeconds).toHaveBeenCalledWith('auto');
    expect(computeCostCredits).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 5 }),
    );

    const createGenerationArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createGenerationArg.params.duration).toBe(5);
    expect(createGenerationArg.params.duration).not.toBe(-1);

    const dispatchInputArg = dispatchMock.mock.calls[0][0];
    expect(dispatchInputArg.durationSeconds).toBe(5);
    expect(dispatchInputArg.durationSeconds).not.toBe(-1);
  });
});

// ─── POST /api/generations — image media_type ─────────────────────────────────

describe('POST /api/generations — image media_type', () => {
  const IMAGE_BODY = {
    prompt: 'a watercolor painting of a fox',
    media_type: 'image',
    model: 'black-forest-labs/flux-schnell',
  };

  it('Test 1: image dispatch with flux-schnell succeeds and returns 200 with generation_id', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-img-1' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-img-1' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(IMAGE_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-img-1', status: 'processing' });

    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        cost_credits: 5,
        media_type: 'image',
        model: 'black-forest-labs/flux-schnell',
      }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 5);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ mediaType: 'image', width: 1024, height: 1024 }),
    );
    expect(attachPredictionId).toHaveBeenCalledWith('gen-img-1', 'pred-img-1');
  });

  it('Test 2: image dispatch with unknown image model returns 400 INVALID_MODEL and never calls dispatch', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...IMAGE_BODY, model: 'stability-ai/sdxl' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('Test 3: image generation cost = 5 credits for flux-schnell via computeImageCostCredits', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-img-2' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-img-2' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    await request(app).post('/api/generations').send(IMAGE_BODY);

    expect(computeImageCostCredits).toHaveBeenCalledWith('black-forest-labs/flux-schnell');
    const createGenerationArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createGenerationArg.cost_credits).toBe(5);
  });

  it('Test 4: insufficient credits for image generation returns 402 without dispatching', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(15);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app)
      .post('/api/generations')
      .send({ ...IMAGE_BODY, model: 'black-forest-labs/flux-dev' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });
});

// ─── GET /api/generations ──────────────────────────────────────────────────────

describe('GET /api/generations', () => {
  const completedItem = {
    id: 'gen-001',
    user_id: 'test-user-id',
    status: 'completed',
    r2_key: 'generations/gen-001.mp4',
    created_at: new Date('2026-06-28T10:00:00Z'),
    prompt: 'a cinematic city',
    model: 'bytedance/seedance-2.0-fast',
    cost_credits: 60,
    params: {},
    replicate_prediction_id: 'pred-abc',
    completed_at: new Date('2026-06-28T10:01:00Z'),
  };
  const pendingItem = {
    id: 'gen-002',
    user_id: 'test-user-id',
    status: 'pending',
    r2_key: null,
    created_at: new Date('2026-06-28T09:00:00Z'),
    prompt: 'a forest',
    model: 'bytedance/seedance-2.0-fast',
    cost_credits: 38,
    params: {},
    replicate_prediction_id: null,
    completed_at: null,
  };

  it('returns 200 with items array and nextCursor null when fewer than limit items returned', async () => {
    (listGenerations as jest.Mock).mockResolvedValue([completedItem, pendingItem]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // completed item gets presigned video_url
    expect(res.body.items[0].video_url).toBe('https://r2.example.com/presigned');
    expect(getGenerationPresignedUrl).toHaveBeenCalledWith('generations/gen-001.mp4');
    // pending item gets null video_url
    expect(res.body.items[1].video_url).toBeNull();
    // fewer than limit (20) → nextCursor is null
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns 401 when no auth token', async () => {
    const unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use('/api/generations', generationsRouter);

    const res = await request(unauthApp).get('/api/generations');
    expect(res.status).toBe(401);
  });

  it('scopes listGenerations to the authenticated user (IDOR check)', async () => {
    (listGenerations as jest.Mock).mockResolvedValue([completedItem]);

    await request(app).get('/api/generations');

    // listGenerations must be called with the authenticated dbUserId, not any other id
    expect(listGenerations).toHaveBeenCalledWith('test-user-id', undefined, 20);
  });

  it('returns nextCursor when page is exactly at limit', async () => {
    // Return exactly 20 items (the default limit)
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...pendingItem,
      id: `gen-${String(i).padStart(3, '0')}`,
      created_at: new Date(`2026-06-28T${String(10 - Math.floor(i / 6)).padStart(2, '0')}:0${i % 6}:00Z`),
    }));
    (listGenerations as jest.Mock).mockResolvedValue(items);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(20);
    expect(res.body.nextCursor).not.toBeNull();
    expect(typeof res.body.nextCursor).toBe('string');
    // nextCursor format: ISO__id
    expect(res.body.nextCursor).toContain('__');
  });
});

// ─── GET /api/generations/:id ─────────────────────────────────────────────────

describe('GET /api/generations/:id', () => {
  const completedGen = {
    id: 'gen-001',
    user_id: 'test-user-id',
    status: 'completed',
    r2_key: 'generations/gen-001.mp4',
    created_at: new Date('2026-06-28T10:00:00Z'),
    prompt: 'a cinematic city',
    model: 'bytedance/seedance-2.0-fast',
    cost_credits: 60,
    params: {},
    replicate_prediction_id: 'pred-abc',
    completed_at: new Date('2026-06-28T10:01:00Z'),
  };

  it('returns 200 with video_url for a completed generation', async () => {
    (getGenerationById as jest.Mock).mockResolvedValue(completedGen);

    const res = await request(app).get('/api/generations/gen-001');

    expect(res.status).toBe(200);
    expect(res.body.video_url).toBe('https://r2.example.com/presigned');
    expect(getGenerationById).toHaveBeenCalledWith('gen-001', 'test-user-id');
  });

  it('returns 404 when getGenerationById returns undefined (IDOR guard)', async () => {
    (getGenerationById as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).get('/api/generations/other-user-gen');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('returns null video_url for a pending generation', async () => {
    (getGenerationById as jest.Mock).mockResolvedValue({
      ...completedGen,
      status: 'pending',
      r2_key: null,
    });

    const res = await request(app).get('/api/generations/gen-001');

    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(getGenerationPresignedUrl).not.toHaveBeenCalled();
  });
});

// ─── DELETE /api/generations/:id ─────────────────────────────────────────────

describe('DELETE /api/generations/:id', () => {
  it('returns 204 on successful soft-delete', async () => {
    (softDeleteGeneration as jest.Mock).mockResolvedValue(true);

    const res = await request(app).delete('/api/generations/gen-001');

    expect(res.status).toBe(204);
    expect(softDeleteGeneration).toHaveBeenCalledWith('gen-001', 'test-user-id');
  });

  it('returns 404 when softDeleteGeneration returns false (IDOR guard — other user ID)', async () => {
    (softDeleteGeneration as jest.Mock).mockResolvedValue(false);

    const res = await request(app).delete('/api/generations/other-user-gen');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found or not authorized');
  });
});

// ─── Input validation (prepareCost middleware) ────────────────────────────────

describe('POST /api/generations — input validation', () => {
  it('returns 400 INVALID_PROMPT when prompt is missing', async () => {
    const { prompt: _p, ...bodyWithoutPrompt } = VALID_BODY as Record<string, unknown>;
    const res = await request(app).post('/api/generations').send(bodyWithoutPrompt);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROMPT');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_PROMPT when prompt is an empty string', async () => {
    const res = await request(app).post('/api/generations').send({ ...VALID_BODY, prompt: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROMPT');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_PROMPT when prompt is a number (not a string)', async () => {
    const res = await request(app).post('/api/generations').send({ ...VALID_BODY, prompt: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROMPT');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_MODEL when model is not in SUPPORTED_MODELS', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, model: 'openai/sora' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_RESOLUTION when resolution is not 480p or 720p', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, resolution: '1080p' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESOLUTION');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_RESOLUTION when resolution is missing', async () => {
    const { resolution: _r, ...bodyWithoutResolution } = VALID_BODY as Record<string, unknown>;
    const res = await request(app).post('/api/generations').send(bodyWithoutResolution);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESOLUTION');
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

// ─── Dispatch failure path ────────────────────────────────────────────────────

describe('POST /api/generations — dispatch failure', () => {
  it('returns 502 and refunds credits immediately when provider.dispatch throws', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-dispatch-fail' });
    dispatchMock.mockRejectedValue(new Error('Replicate unreachable'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(502);
    expect(markFailed).toHaveBeenCalledWith('gen-dispatch-fail');
    expect(markRefunded).not.toHaveBeenCalled();
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      60,
      'dispatch-failure-gen-dispatch-fail',
    );
    expect(attachPredictionId).not.toHaveBeenCalled();
  });
});

// ─── Reference token auto-append (D-23, D-24) ────────────────────────────────

describe('POST /api/generations — reference token auto-append', () => {
  beforeEach(() => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(38);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-ref-test' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-ref' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);
  });

  it('appends @Image1 to prompt when reference_images provided and token absent', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_images: ['https://r2.example.com/img.jpg'] });

    expect(res.status).toBe(200);
    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(genArg.prompt).toContain('@Image1');
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual(['https://r2.example.com/img.jpg']);
  });

  it('does NOT double-append @Image1 when it is already in the prompt', async () => {
    await request(app)
      .post('/api/generations')
      .send({
        ...VALID_BODY,
        prompt: 'a scene with @Image1 in foreground',
        reference_images: ['https://r2.example.com/img.jpg'],
      });

    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    const count = (genArg.prompt.match(/@Image1/g) || []).length;
    expect(count).toBe(1);
  });

  it('appends @Video1 to prompt when reference_videos provided and token absent', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_videos: ['https://r2.example.com/vid.mp4'] });

    expect(res.status).toBe(200);
    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(genArg.prompt).toContain('@Video1');
    expect(dispatchMock.mock.calls[0][0].referenceVideos).toEqual(['https://r2.example.com/vid.mp4']);
  });

  it('passes hasVideoReference=true to computeCostCredits when reference_videos present — prevents cost gaming (T-07-04-03)', async () => {
    await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_videos: ['https://r2.example.com/vid.mp4'] });

    expect(computeCostCredits).toHaveBeenCalledWith(
      expect.objectContaining({ hasVideoReference: true }),
    );
  });

  it('strips non-string entries from reference_images (null/undefined/number filtering)', async () => {
    await request(app)
      .post('/api/generations')
      .send({
        ...VALID_BODY,
        reference_images: [null, 'https://r2.example.com/img.jpg', undefined, 42],
      });

    // Only the valid string URL passes through to dispatch
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual(['https://r2.example.com/img.jpg']);
  });
});
