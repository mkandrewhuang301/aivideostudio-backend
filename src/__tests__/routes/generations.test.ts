// src/__tests__/routes/generations.test.ts
// Integration tests for POST /api/generations.
// Covers video dispatch (SC-1), zero-credit rejection (SC-5), duration validation,
// image dispatch via Replicate (Seedream), and the inline OpenAI path (gpt-image-2).

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
    openaiApiKey: 'mock-openai-key',
    port: 3000,
    nodeEnv: 'test',
    // Moderation policy v2 uses the scoped real-face-path switch.
    hiveScanRealFacePaths: true,
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
  getFalWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/fal'),
}));

jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    insert: jest.fn(),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([]),
      })),
    })),
    // Magic Editor's presetResolver branch tags the mask upload's `kind` via db.update(...).set(...).where(...)
    // after resolving mask_upload_id (2026-07-13 fix keeping masks out of the @-mention reference list).
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn().mockResolvedValue(undefined),
      })),
    })),
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
  computeDreamActorCost: jest.fn(),
  computeUpscalerCost: jest.fn(),
  computeImageUpscaleCost: jest.fn(),
  computeGrokImagineCost: jest.fn(),
  computeFalKlingV3Cost: jest.fn(),
  computeFalKlingCost: jest.fn(),
  computeVideoBackgroundRemovalCost: jest.fn(),
  resolveFalKlingV3Duration: jest.fn(),
  computeHappyHorseCost: jest.fn(),
  resolveHappyHorseDuration: jest.fn(),
  computeFaceswapCost: jest.fn(),
  createGeneration: jest.fn(),
  attachPredictionId: jest.fn(),
  markRefunded: jest.fn(),
  markFailed: jest.fn(),
  markCompleted: jest.fn(),
  markQuarantined: jest.fn(),
  listGenerations: jest.fn(),
  getGenerationById: jest.fn(),
  softDeleteGeneration: jest.fn(),
  SUPPORTED_MODELS: ['bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0'],
  MODEL_RESOLUTIONS: {
    'bytedance/seedance-2.0-fast': ['480p', '720p'],
    'bytedance/seedance-2.0-mini': ['480p', '720p'],
    'bytedance/seedance-2.0':      ['480p', '720p', '1080p', '4k'],
    'xai/grok-imagine-video-1.5':  ['480p', '720p'],
    'alibaba/happyhorse-1.1':      ['720p', '1080p'],
  },
  SUPPORTED_IMAGE_MODELS: ['openai/gpt-image-2-high', 'openai/gpt-image-2-medium', 'openai/gpt-image-2-low', 'openai/gpt-image-2', 'pixelcut/background-removal'],
  SUPPORTED_AVATAR_MODELS: ['bytedance/dreamactor-m2.0'],
  SUPPORTED_UPSCALER_MODELS: ['bytedance/video-upscaler'],
  SUPPORTED_IMAGE_UPSCALE_MODELS: ['recraft-ai/recraft-crisp-upscale'],
  SUPPORTED_GROK_MODELS: ['xai/grok-imagine-video-1.5'],
  SUPPORTED_FAL_KLING_MODELS: ['fal-ai/kling-video/v3/standard/image-to-video'],
  SUPPORTED_HAPPYHORSE_MODELS: ['alibaba/happyhorse-1.1'],
  SUPPORTED_FACESWAP_MODELS: ['openai/gpt-image-2-medium'],
  computeCharacterReplaceCost: jest.fn(),
  computeChainCost: jest.fn(),
  classifyFailureReason: jest.requireActual('../../services/generationService').classifyFailureReason,
}));

jest.mock('../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
  getGenerationPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned'),
  getUploadPresignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/fresh-signed-ref?X-Amz-Expires=3600'),
}));

jest.mock('../../services/providers/ReplicateProvider', () => {
  return {
    ReplicateProvider: jest.fn().mockImplementation(() => ({
      dispatch: jest.fn(),
    })),
  };
});

jest.mock('../../services/providers/FalProvider', () => ({
  FAL_IMAGE_BACKGROUND_REMOVAL_MODEL: 'pixelcut/background-removal',
  FAL_VIDEO_BACKGROUND_REMOVAL_MODEL: 'pixelcut/video-background-removal',
  isFalAsyncVideoModel: jest.fn((model: string) => [
    'fal-ai/kling-video/v3/standard/image-to-video',
    'pixelcut/video-background-removal',
  ].includes(model)),
  FalProvider: jest.fn().mockImplementation(() => ({
    dispatch: jest.fn(),
  })),
}));

jest.mock('../../services/mediaProbe', () => ({
  probeVideoFrameCount: jest.fn(),
}));

// generateImageEditWithMask/generateFaceswap moved to openaiGenerationWorker.ts (09.2-13, D-C) —
// mocked here only so tests can assert the route NEVER calls them directly anymore (moved to the
// background worker's own test suite, openaiGenerationWorker.test.ts).
jest.mock('../../services/openaiImageService', () => ({
  generateImageWithOpenAI: jest.fn(),
  generateImageEditWithMask: jest.fn(),
  generateFaceswap: jest.fn(),
}));

// 09.2-13 (D-C): the async OpenAI generation queue — faceswap + Magic Editor now enqueue onto
// this instead of running the OpenAI call inline in the request.
jest.mock('../../queue/openaiGenerationQueue', () => ({
  openaiGenerationQueue: {
    add: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../queue/falImageToolQueue', () => ({
  falImageToolQueue: {
    add: jest.fn().mockResolvedValue(undefined),
  },
}));

// 09.6-05: the chained-job primitive (UVU) enqueues onto this instead of dispatching inline.
jest.mock('../../queue/chainGenerationQueue', () => ({
  chainGenerationQueue: {
    add: jest.fn().mockResolvedValue(undefined),
  },
}));

// 14-06: generations.ts imports the Explainer queue for format requests. Keep the legacy route
// suite isolated from Redis; format enqueue behavior has dedicated coverage next door.
jest.mock('../../queue/explainerGenerationQueue', () => ({
  explainerGenerationQueue: {
    add: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../queue/influencerProQueue', () => ({
  influencerProQueue: {
    add: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/apnsService', () => ({
  sendGenerationComplete: jest.fn().mockResolvedValue(undefined),
}));

// Mock promptModerationMiddleware as a pass-through — moderation logic is tested separately
jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock inputMediaGate as a pass-through — NSFW input-scan logic is tested separately (09.2-02/06);
// without this, faceswap/avatar route tests would otherwise hit Hive via scanInputMedia.
jest.mock('../../middleware/inputMediaGate', () => ({
  inputMediaGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock celebrityCheckMiddleware as a pass-through — Rekognition celebrity-check logic is tested
// separately (celebrityCheck.test.ts); disabled by default via config.celebrityCheckEnabled
// anyway, but mocked explicitly here for the same reason as inputMediaGate above.
jest.mock('../../middleware/celebrityCheck', () => ({
  celebrityCheckMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Mock entitlementGate/concurrencyGate as pass-throughs — tier/concurrency gating logic is
// tested separately (entitlementGate.test.ts, concurrencyGate.test.ts). Without this, every test
// in this suite would need a mocked users.entitlement_level row (this suite's db mock returns
// `{ rows: [] }` by default, which the hard-paywall gate would otherwise treat as NULL → 403).
jest.mock('../../middleware/entitlementGate', () => ({
  entitlementGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/concurrencyGate', () => ({
  concurrencyGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { generationsRouter } from '../../routes/generations';
import { deductCredits, refundCredits } from '../../services/creditService';
import {
  resolveDurationSeconds,
  computeCostCredits,
  computeImageCostCredits,
  computeDreamActorCost,
  computeUpscalerCost,
  computeImageUpscaleCost,
  computeGrokImagineCost,
  computeFalKlingV3Cost,
  computeFalKlingCost,
  computeVideoBackgroundRemovalCost,
  resolveFalKlingV3Duration,
  computeHappyHorseCost,
  resolveHappyHorseDuration,
  computeFaceswapCost,
  computeChainCost,
  createGeneration,
  attachPredictionId,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
  markRefunded,
  markFailed,
} from '../../services/generationService';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../../services/archivalService';
import { generateImageWithOpenAI, generateImageEditWithMask, generateFaceswap } from '../../services/openaiImageService';
import { openaiGenerationQueue } from '../../queue/openaiGenerationQueue';
import { falImageToolQueue } from '../../queue/falImageToolQueue';
import { chainGenerationQueue } from '../../queue/chainGenerationQueue';
import { ReplicateProvider } from '../../services/providers/ReplicateProvider';
import { FalProvider } from '../../services/providers/FalProvider';
import { db } from '../../db/client';
import { probeVideoFrameCount } from '../../services/mediaProbe';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;
const MockedFalProvider = FalProvider as jest.MockedClass<typeof FalProvider>;
const falProviderInstance = MockedFalProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const falDispatchMock = falProviderInstance.dispatch;

const app = express();
app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});

app.use('/api/generations', generationsRouter);

const VALID_BODY = {
  prompt: 'a cinematic shot of a city at night',
  model: 'bytedance/seedance-2.0-mini',
  duration: 8,
  resolution: '720p' as const,
  aspect_ratio: '16:9',
  audio_enabled: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  (db.execute as jest.Mock).mockResolvedValue({ rows: [] });
});

// ─── POST /api/generations — video ────────────────────────────────────────────

describe('POST /api/generations — video', () => {
  it('dispatches and returns 200 with generation_id + processing on success', async () => {
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

  it('insufficient credits returns 402 and never calls ReplicateProvider.dispatch', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(8);
    (computeCostCredits as jest.Mock).mockReturnValue(60);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app).post('/api/generations').send(VALID_BODY);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it("duration 'auto' resolves to explicit seconds, never -1, in DB insert and dispatch input", async () => {
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

    const createArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createArg.params.duration).toBe(5);
    expect(createArg.params.duration).not.toBe(-1);

    const dispatchArg = dispatchMock.mock.calls[0][0];
    expect(dispatchArg.durationSeconds).toBe(5);
    expect(dispatchArg.durationSeconds).not.toBe(-1);
  });

  it('out-of-range duration returns 400 before credit deduction is attempted', async () => {
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
});

// ─── POST /api/generations — xAI Grok Imagine Video 1.5 ──────────────────────

describe('POST /api/generations — Grok Imagine (image-to-video)', () => {
  const GROK_BODY = {
    prompt: 'cinematic motion, sunlight filtering into the room',
    model: 'xai/grok-imagine-video-1.5',
    duration: 5,
    resolution: '720p' as const,
    aspect_ratio: '16:9',
    reference_images: ['https://example.com/source.png'],
  };

  it('returns 400 INVALID_INPUT when reference_images is missing, without dispatch', async () => {
    const { reference_images: _omit, ...bodyWithoutImage } = GROK_BODY;

    const res = await request(app).post('/api/generations').send(bodyWithoutImage);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('dispatches with computeGrokImagineCost (flat rate) and returns 200', async () => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeGrokImagineCost as jest.Mock).mockReturnValue(40);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-grok-1' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-grok-1' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(GROK_BODY);

    expect(res.status).toBe(200);
    expect(computeGrokImagineCost).toHaveBeenCalledWith(5);
    expect(computeCostCredits).not.toHaveBeenCalled();
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 40, media_type: 'video' }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 40);

    const dispatchArg = dispatchMock.mock.calls[0][0];
    expect(dispatchArg.referenceImages).toEqual(['https://example.com/source.png']);
  });

  it('returns 400 INVALID_RESOLUTION for an unsupported resolution (e.g. 1080p)', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...GROK_BODY, resolution: '1080p' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESOLUTION');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — fal Kling v3 Standard image-to-video ────────────

describe('POST /api/generations — fal Kling v3 Standard image-to-video', () => {
  const KLING_BODY = {
    prompt: 'slow cinematic push-in [Image1]',
    model: 'fal-ai/kling-video/v3/standard/image-to-video',
    duration: 5,
    resolution: '720p' as const,
    aspect_ratio: '9:16',
    audio_enabled: true,
    reference_images: ['https://example.com/start.png'],
  };

  it('requires exactly one start image before deduction or dispatch', async () => {
    const res = await request(app).post('/api/generations').send({ ...KLING_BODY, reference_images: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(falDispatchMock).not.toHaveBeenCalled();
  });

  it('prices audio-on, strips the composer token, and dispatches only through FalProvider', async () => {
    (resolveFalKlingV3Duration as jest.Mock).mockReturnValue(5);
    (computeFalKlingCost as jest.Mock).mockReturnValue(63);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-fal-kling-1' });
    falDispatchMock.mockResolvedValue({
      providerPredictionId: 'fal-ai/kling-video/v3/standard/image-to-video::req-1',
    });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(KLING_BODY);

    expect(res.status).toBe(200);
    expect(resolveFalKlingV3Duration).toHaveBeenCalledWith(5);
    expect(computeFalKlingCost).toHaveBeenCalledWith(KLING_BODY.model, 5, true);
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 63);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(falDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: KLING_BODY.model,
        prompt: 'slow cinematic push-in',
        durationSeconds: 5,
        audioEnabled: true,
        referenceImages: KLING_BODY.reference_images,
      }),
      'https://mock.example.com/webhooks/fal',
    );
  });

  it('prices audio-off independently', async () => {
    (resolveFalKlingV3Duration as jest.Mock).mockReturnValue(5);
    (computeFalKlingCost as jest.Mock).mockReturnValue(42);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-fal-kling-2' });
    falDispatchMock.mockResolvedValue({ providerPredictionId: 'fal-model::req-2' });

    const res = await request(app).post('/api/generations').send({ ...KLING_BODY, audio_enabled: false });

    expect(res.status).toBe(200);
    expect(computeFalKlingCost).toHaveBeenCalledWith(KLING_BODY.model, 5, false);
  });
});

// ─── POST /api/generations — Pixelcut transparent video cutout ──────────────

describe('POST /api/generations — video background removal', () => {
  it('rejects a raw client URL so server-side ffprobe can only reach owned preset uploads', async () => {
    const res = await request(app).post('/api/generations').send({
      prompt: '',
      model: 'pixelcut/video-background-removal',
      media_type: 'video',
      reference_videos: ['http://127.0.0.1/internal'],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(probeVideoFrameCount).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — Alibaba HappyHorse 1.1 ──────────────────────────

describe('POST /api/generations — HappyHorse 1.1 (t2v + i2v)', () => {
  const HH_BODY = {
    prompt: 'a chef plating a dish, warm kitchen light, gentle push-in',
    model: 'alibaba/happyhorse-1.1',
    duration: 5,
    resolution: '720p' as const,
    aspect_ratio: '16:9',
  };

  it('dispatches text-to-video (no images) via computeHappyHorseCost and returns 200', async () => {
    (resolveHappyHorseDuration as jest.Mock).mockReturnValue(5);
    (computeHappyHorseCost as jest.Mock).mockReturnValue(70);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-hh-1' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-hh-1' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(HH_BODY);

    expect(res.status).toBe(200);
    expect(computeHappyHorseCost).toHaveBeenCalledWith(5, '720p');
    expect(computeCostCredits).not.toHaveBeenCalled();
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 70, media_type: 'video' }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 70);

    const dispatchArg = dispatchMock.mock.calls[0][0];
    expect(dispatchArg.referenceImages).toBeUndefined(); // t2v — no image slot
    expect(dispatchArg.audioEnabled).toBe(true); // native audio always on
  });

  it('dispatches single-image image-to-video (1 reference image) and returns 200', async () => {
    (resolveHappyHorseDuration as jest.Mock).mockReturnValue(5);
    (computeHappyHorseCost as jest.Mock).mockReturnValue(70);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-hh-2' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-hh-2' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/generations')
      .send({ ...HH_BODY, reference_images: ['https://example.com/first-frame.png'] });

    expect(res.status).toBe(200);
    const dispatchArg = dispatchMock.mock.calls[0][0];
    expect(dispatchArg.referenceImages).toEqual(['https://example.com/first-frame.png']);
  });

  it('returns 400 INVALID_INPUT when 2+ reference images are sent (r2v deferred), without dispatch', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...HH_BODY, reference_images: ['https://example.com/a.png', 'https://example.com/b.png'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_RESOLUTION for an unsupported resolution (e.g. 480p)', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...HH_BODY, resolution: '480p' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESOLUTION');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — Faceswap (async OpenAI gpt-image-2, 09.2-13) ─────
// Easel Advanced Face Swap was REMOVED from Replicate (404) — faceswap dispatches to gpt-image-2.
// D-C (09.2-13 gap closure): the OpenAI call USED to run synchronously in-request (~47s — past
// the client's HTTP timeout). Now the route only ENQUEUES the job onto openaiGenerationWorker.ts
// and returns 'processing' immediately; the worker's own behavior (generateFaceswap call, CSAM
// scan, markCompleted/markFailed/refund, no raw-face deletion per D-E) is covered separately in
// openaiGenerationWorker.test.ts.

describe('POST /api/generations — faceswap (async, enqueues to openaiGenerationWorker)', () => {
  const FACESWAP_BODY = {
    media_type: 'faceswap',
    model: 'openai/gpt-image-2-medium',
    swap_image: 'https://example.com/swap-face.jpg',
    target_image: 'https://example.com/target-photo.jpg',
  };

  it('returns 400 INVALID_INPUT when swap_image is missing, without dispatch or deduction', async () => {
    const { swap_image: _omit, ...bodyWithoutSwapImage } = FACESWAP_BODY;

    const res = await request(app).post('/api/generations').send(bodyWithoutSwapImage);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_INPUT when target_image is missing, without dispatch or deduction', async () => {
    const { target_image: _omit, ...bodyWithoutTargetImage } = FACESWAP_BODY;

    const res = await request(app).post('/api/generations').send(bodyWithoutTargetImage);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_MODEL for a model not in SUPPORTED_FACESWAP_MODELS (e.g. the dead easel model)', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...FACESWAP_BODY, model: 'easel/advanced-face-swap' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('enqueues a faceswap job and returns processing immediately — never calls generateFaceswap or Replicate dispatch in-request', async () => {
    (computeFaceswapCost as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-faceswap-1' });

    const res = await request(app).post('/api/generations').send(FACESWAP_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-faceswap-1', status: 'processing' });
    expect(computeFaceswapCost).toHaveBeenCalled();
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 5, media_type: 'faceswap' }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 5);
    // Image order is load-bearing: targetImage=target_image, faceImage=swap_image
    expect(openaiGenerationQueue.add).toHaveBeenCalledWith('generate', {
      kind: 'faceswap',
      generationId: 'gen-faceswap-1',
      userId: 'test-user-id',
      cost: 5,
      targetImage: 'https://example.com/target-photo.jpg',
      faceImage: 'https://example.com/swap-face.jpg',
    });
    expect(generateFaceswap).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
  });

  it('enqueue failure returns 502 with refund, never leaves the row pending unrefunded', async () => {
    (computeFaceswapCost as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-faceswap-enqueue-fail' });
    (openaiGenerationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis unreachable'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(FACESWAP_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledWith('gen-faceswap-enqueue-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      5,
      'dispatch-failure-gen-faceswap-enqueue-fail',
    );
    expect(generateFaceswap).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — chain (09.6-05, D-01/D-05) ──────────────────────
// The chained-job primitive's sole consumer is You vs You (UVU). This is the ONLY resolved
// mediaType that never dispatches inline in this route — it always enqueues onto
// chainGenerationQueue and returns 'processing' immediately; Stage1/Stage2 dispatch logic itself
// is covered separately in chainGenerationWorker.test.ts.

describe('POST /api/generations — chain (async, enqueues to chainGenerationWorker)', () => {
  const CHAIN_DEF = {
    image_stage: { model: 'wan-video/wan-2.7-image', quality: 'high' as const, prompts: ['opening keyframe', 'reveal keyframe'] },
    animate_stage: { model: 'alibaba/happyhorse-1.1', resolution: '720p' as const, duration: 8, aspect_ratio: '9:16', prompt_template: 'choreography prompt' },
  };
  const CHAIN_BODY = {
    media_type: 'chain',
    chain_input_images: ['https://example.com/user-photo.jpg'],
    __chain_def: CHAIN_DEF,
  };

  it('returns 400 INVALID_INPUT when chain_input_images is empty, without dispatch or deduction', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...CHAIN_BODY, chain_input_images: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(chainGenerationQueue.add).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('enqueues a chain job and returns processing immediately — never dispatches inline', async () => {
    (computeChainCost as jest.Mock).mockReturnValue(30);
    (resolveHappyHorseDuration as jest.Mock).mockReturnValue(8);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-chain-1' });

    const res = await request(app).post('/api/generations').send(CHAIN_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-chain-1', status: 'processing' });
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', cost_credits: 30, media_type: 'chain' }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 30);
    expect(chainGenerationQueue.add).toHaveBeenCalledWith('generate', {
      generationId: 'gen-chain-1',
      userId: 'test-user-id',
      cost: 30,
      userPhotoUrls: ['https://example.com/user-photo.jpg'],
      imageStage: CHAIN_DEF.image_stage,
      animateStage: CHAIN_DEF.animate_stage,
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
  });

  it('enqueue failure returns 502 with refund, never leaves the row pending unrefunded', async () => {
    (computeChainCost as jest.Mock).mockReturnValue(30);
    (resolveHappyHorseDuration as jest.Mock).mockReturnValue(8);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-chain-enqueue-fail' });
    (chainGenerationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis unreachable'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(CHAIN_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledWith('gen-chain-enqueue-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      30,
      'dispatch-failure-gen-chain-enqueue-fail',
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — gpt-image-2 image (Replicate path) ──────────────
// Seedream 5 Lite / 4.5 paused — worse output quality than gpt-image-2 (.planning/STATE.md).

describe('POST /api/generations — gpt-image-2 image (Replicate)', () => {
  const IMAGE_BODY = {
    prompt: 'a watercolor painting of a fox',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium',
  };

  it('image dispatch with gpt-image-2-medium succeeds and returns 200 with generation_id', async () => {
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
        model: 'openai/gpt-image-2-medium',
      }),
    );
    expect(deductCredits).toHaveBeenCalledWith('test-user-id', 5);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    // dispatch input must have mediaType, imageAspectRatio, and imageQuality resolved from the model ID
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ mediaType: 'image', imageAspectRatio: '1:1', imageQuality: 'medium', model: 'openai/gpt-image-2-medium' }),
    );
    expect(attachPredictionId).toHaveBeenCalledWith('gen-img-1', 'pred-img-1');
  });

  it('image dispatch with unknown model returns 400 INVALID_MODEL without dispatch', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...IMAGE_BODY, model: 'stability-ai/sdxl' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('image dispatch with a paused Seedream model returns 400 INVALID_MODEL without dispatch', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...IMAGE_BODY, model: 'bytedance/seedream-5-lite' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('cost is computed by computeImageCostCredits and stored in generation row', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-img-2' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-img-2' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    await request(app).post('/api/generations').send(IMAGE_BODY);

    expect(computeImageCostCredits).toHaveBeenCalledWith('openai/gpt-image-2-medium');
    const createArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createArg.cost_credits).toBe(5);
  });

  it('insufficient credits for image generation returns 402 without dispatch', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app)
      .post('/api/generations')
      .send({ ...IMAGE_BODY, model: 'openai/gpt-image-2-high' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('Replicate dispatch failure for gpt-image-2 returns 502 with refund', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-img-fail' });
    dispatchMock.mockRejectedValue(new Error('Replicate 422 model not found'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(IMAGE_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledWith('gen-img-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('test-user-id', 5, 'dispatch-failure-gen-img-fail');
    expect(attachPredictionId).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — fal photo background removal ────────────────────

describe('POST /api/generations — photo background removal', () => {
  const BODY = {
    prompt: '',
    media_type: 'image',
    model: 'pixelcut/background-removal',
    reference_images: ['https://r2.example.com/source.png'],
  };

  it('charges two credits, enqueues the worker, and never dispatches inline', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(2);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-remove-bg-photo' });

    const res = await request(app).post('/api/generations').send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-remove-bg-photo', status: 'processing' });
    expect(computeImageCostCredits).toHaveBeenCalledWith('pixelcut/background-removal');
    expect(falImageToolQueue.add).toHaveBeenCalledWith('generate', {
      kind: 'remove-background',
      generationId: 'gen-remove-bg-photo',
      userId: 'test-user-id',
      cost: 2,
      sourceImage: 'https://r2.example.com/source.png',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(falDispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
  });

  it('rejects a missing source image before billing or row creation', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...BODY, reference_images: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(falImageToolQueue.add).not.toHaveBeenCalled();
  });

  it('refunds atomically when enqueueing fails', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(2);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-remove-bg-enqueue-fail' });
    (falImageToolQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis unreachable'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(BODY);

    expect(res.status).toBe(502);
    expect(markFailed).toHaveBeenCalledWith('gen-remove-bg-enqueue-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      2,
      'dispatch-failure-gen-remove-bg-enqueue-fail',
    );
  });
});

// ─── POST /api/generations — Magic Editor mask edit (async, 09.2-13 / SC4) ────
//
// Routed by resolved.maskUrl (set from req.body.mask_url), not by model id, so these tests send
// mask_url directly on the request body (mirroring how presetResolver would set it for preset_id
// 'magic-editor' — see the dedicated preset-resolution coverage in the "presets" describe below).
// D-C (09.2-13 gap closure): mask edits USED to run the OpenAI call synchronously in-request —
// now the route only ENQUEUES the job onto openaiGenerationWorker.ts and returns 'processing'
// immediately; the worker's behavior (generateImageEditWithMask call, CSAM scan, markCompleted/
// markFailed/refund) is covered separately in openaiGenerationWorker.test.ts.
describe('POST /api/generations — magic editor mask edit (async)', () => {
  const MASK_BODY = {
    prompt: 'remove the trash can',
    media_type: 'image',
    model: 'openai/gpt-image-2-medium',
    reference_images: ['https://r2.example.com/source.png'],
    mask_url: 'https://r2.example.com/mask.png',
  };

  it('enqueues a magic-editor job and returns processing — never calls generateImageEditWithMask or Replicate dispatch in-request', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-mask-1' });

    const res = await request(app).post('/api/generations').send(MASK_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-mask-1', status: 'processing' });
    expect(openaiGenerationQueue.add).toHaveBeenCalledWith('generate', {
      kind: 'magic-editor',
      generationId: 'gen-mask-1',
      userId: 'test-user-id',
      cost: 5,
      sourceImage: 'https://r2.example.com/source.png',
      maskUrl: 'https://r2.example.com/mask.png',
      prompt: 'remove the trash can',
    });
    expect(generateImageEditWithMask).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
  });

  it('enqueue failure returns 502 with refund, never leaves the row pending unrefunded', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-mask-enqueue-fail' });
    (openaiGenerationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis unreachable'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(MASK_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledWith('gen-mask-enqueue-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      5,
      'dispatch-failure-gen-mask-enqueue-fail',
    );
    expect(generateImageEditWithMask).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('insufficient credits for a mask edit returns 402 without enqueueing', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app).post('/api/generations').send(MASK_BODY);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(openaiGenerationQueue.add).not.toHaveBeenCalled();
    expect(generateImageEditWithMask).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('a plain gpt-image-2 request with no mask_url still dispatches via Replicate (blast-radius guard)', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-no-mask' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-no-mask' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const { mask_url: _omit, ...NO_MASK_BODY } = MASK_BODY;
    const res = await request(app).post('/api/generations').send(NO_MASK_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-no-mask', status: 'processing' });
    expect(openaiGenerationQueue.add).not.toHaveBeenCalled();
    expect(generateImageEditWithMask).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /api/generations — Replicate dispatch failure ──────────────────────

describe('POST /api/generations — dispatch failure (video)', () => {
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
    expect(markFailed).toHaveBeenCalledWith('gen-dispatch-fail', 'generic_error');
    expect(markRefunded).not.toHaveBeenCalled();
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      60,
      'dispatch-failure-gen-dispatch-fail',
    );
    expect(attachPredictionId).not.toHaveBeenCalled();
  });
});

// ─── POST /api/generations — reference token auto-append ─────────────────────

describe('POST /api/generations — reference token auto-append', () => {
  beforeEach(() => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(38);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-ref-test' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-ref' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);
  });

  it('appends [Image1] to prompt when reference_images provided and token absent', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_images: ['https://r2.example.com/img.jpg'] });

    expect(res.status).toBe(200);
    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(genArg.prompt).toContain('[Image1]');
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual(['https://r2.example.com/img.jpg']);
  });

  it('does NOT double-append [Image1] when it is already in the prompt', async () => {
    await request(app)
      .post('/api/generations')
      .send({
        ...VALID_BODY,
        prompt: 'a scene with [Image1] in foreground',
        reference_images: ['https://r2.example.com/img.jpg'],
      });

    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    const count = (genArg.prompt.match(/\[Image1\]/g) || []).length;
    expect(count).toBe(1);
  });

  it('appends [Video1] to prompt when reference_videos provided and token absent', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_videos: ['https://r2.example.com/vid.mp4'] });

    expect(res.status).toBe(200);
    const genArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(genArg.prompt).toContain('[Video1]');
    expect(dispatchMock.mock.calls[0][0].referenceVideos).toEqual(['https://r2.example.com/vid.mp4']);
  });

  it('passes hasVideoReference=true to computeCostCredits when reference_videos present', async () => {
    await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, reference_videos: ['https://r2.example.com/vid.mp4'] });

    expect(computeCostCredits).toHaveBeenCalledWith(
      expect.objectContaining({ hasVideoReference: true }),
    );
  });

  it('strips non-string entries from reference_images', async () => {
    await request(app)
      .post('/api/generations')
      .send({
        ...VALID_BODY,
        reference_images: [null, 'https://r2.example.com/img.jpg', undefined, 42],
      });

    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual(['https://r2.example.com/img.jpg']);
  });
});

// ─── POST /api/generations — reference URL re-signing (Issue 4) ──────────────

describe('POST /api/generations — reference URL re-signing', () => {
  beforeEach(() => {
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(38);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-resign-test' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-resign' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);
  });

  it('re-signs a stale reference_images URL when reference_image_upload_ids provides the owning id', async () => {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([
          { id: 'upload-real-id', user_id: 'test-user-id', r2_key: 'uploads/test-user-id/real.jpg', mime_type: 'image/jpeg' },
        ]),
      })),
    });

    const res = await request(app).post('/api/generations').send({
      ...VALID_BODY,
      reference_images: ['https://r2.example.com/stale-signed-url?X-Amz-Expires=1'],
      reference_image_upload_ids: ['upload-real-id'],
    });

    expect(res.status).toBe(200);
    expect(getUploadPresignedUrl).toHaveBeenCalledWith('uploads/test-user-id/real.jpg');
    // Same index (0), freshly-signed URL substituted for the stale client-sent one.
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
      'https://r2.example.com/fresh-signed-ref?X-Amz-Expires=3600',
    ]);
  });

  it('leaves the client-sent URL untouched at indices with no upload id (null placeholder)', async () => {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([
          { id: 'upload-real-id', user_id: 'test-user-id', r2_key: 'uploads/test-user-id/real.jpg', mime_type: 'image/jpeg' },
        ]),
      })),
    });

    const res = await request(app).post('/api/generations').send({
      ...VALID_BODY,
      reference_images: ['https://r2.example.com/no-id-url.jpg', 'https://r2.example.com/stale.jpg'],
      reference_image_upload_ids: [null, 'upload-real-id'],
    });

    expect(res.status).toBe(200);
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
      'https://r2.example.com/no-id-url.jpg', // untouched — no id at this index
      'https://r2.example.com/fresh-signed-ref?X-Amz-Expires=3600', // re-signed
    ]);
  });
});

// ─── POST /api/generations — presets (09.1-04: presetResolver) ───────────────
// SC2: preset_id expands server template, overwrites model/media_type/prompt, bills correct
// cost per preset. SC3/T-09.1-02/T-09.1-07: tampering-proof + duration clamp (D-16).

function mockUploadRows(rows: Array<{ id: string; r2_key: string }>): void {
  (db.select as jest.Mock).mockReturnValue({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue(
        rows.map((r) => ({ ...r, user_id: 'test-user-id', mime_type: 'image/jpeg' })),
      ),
    })),
  });
}

// Magic Editor's presetResolver branch issues TWO sequential db.select() calls per request — the
// slot-resolution query (source image), then a SEPARATE query resolving mask_upload_id. Unlike
// mockUploadRows (one static result for every call), this queues a distinct result per call in
// order so the mask query doesn't just echo back the slot query's row.
function mockUploadRowsSequence(...batches: Array<Array<{ id: string; r2_key: string }>>): void {
  const mockSelect = db.select as jest.Mock;
  for (const batch of batches) {
    mockSelect.mockReturnValueOnce({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue(
          batch.map((r) => ({ ...r, user_id: 'test-user-id', mime_type: 'image/jpeg' })),
        ),
      })),
    });
  }
}

describe('POST /api/generations — presets', () => {
  beforeEach(() => {
    (getUploadPresignedUrl as jest.Mock).mockImplementation((key: string) =>
      Promise.resolve(`https://r2.example.com/signed/${key}`),
    );
  });

  it('hairstyle: expands template with the validated style label, overwrites model/media_type, bills computeImageCostCredits', async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/test-user-id/photo.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-hairstyle' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-hairstyle' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'hairstyle',
      style_id: 'bob',
      preset_input_upload_ids: ['upload-photo'],
    });

    expect(res.status).toBe(200);
    expect(computeImageCostCredits).toHaveBeenCalledWith('openai/gpt-image-2-medium');
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 'image',
        model: 'openai/gpt-image-2-medium',
        cost_credits: 5,
        prompt: expect.stringContaining('Bob'),
        params: expect.objectContaining({
          preset_id: 'hairstyle',
          preset_input_upload_ids: ['upload-photo'],
        }),
      }),
    );
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        mediaType: 'image',
        model: 'openai/gpt-image-2-medium',
        referenceImages: [
          'https://r2.example.com/signed/uploads/test-user-id/photo.jpg',
          'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bob-v1.jpg',
        ],
      }),
    );
  });

  it('remove-background-photo: resolves the owned upload and enqueues the fal image worker', async () => {
    mockUploadRows([{ id: 'upload-cutout', r2_key: 'uploads/test-user-id/cutout.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(2);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-cutout-preset' });

    const res = await request(app).post('/api/generations').send({
      preset_id: 'remove-background-photo',
      preset_input_upload_ids: ['upload-cutout'],
    });

    expect(res.status).toBe(200);
    expect(computeImageCostCredits).toHaveBeenCalledWith('pixelcut/background-removal');
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 'image',
        model: 'pixelcut/background-removal',
        cost_credits: 2,
        params: expect.objectContaining({
          preset_id: 'remove-background-photo',
          preset_input_upload_ids: ['upload-cutout'],
        }),
      }),
    );
    expect(falImageToolQueue.add).toHaveBeenCalledWith('generate', {
      kind: 'remove-background',
      generationId: 'gen-cutout-preset',
      userId: 'test-user-id',
      cost: 2,
      sourceImage: 'https://r2.example.com/signed/uploads/test-user-id/cutout.jpg',
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(falDispatchMock).not.toHaveBeenCalled();
  });

  it('remove-background-video: resolves the owned video, probes it pre-billing, and dispatches fal', async () => {
    mockUploadRows([{ id: 'upload-video-cutout', r2_key: 'uploads/test-user-id/cutout.mp4' }]);
    (probeVideoFrameCount as jest.Mock).mockResolvedValue(90);
    (computeVideoBackgroundRemovalCost as jest.Mock).mockReturnValue(9);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-video-cutout-preset' });
    falDispatchMock.mockResolvedValue({
      providerPredictionId: 'pixelcut/video-background-removal::req-preset-1',
    });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'remove-background-video',
      preset_input_upload_ids: ['upload-video-cutout'],
    });

    const signedVideo = 'https://r2.example.com/signed/uploads/test-user-id/cutout.mp4';
    expect(res.status).toBe(200);
    expect(probeVideoFrameCount).toHaveBeenCalledWith(signedVideo);
    expect(computeVideoBackgroundRemovalCost).toHaveBeenCalledWith(90);
    expect(createGeneration).toHaveBeenCalledWith(expect.objectContaining({
      media_type: 'video',
      model: 'pixelcut/video-background-removal',
      cost_credits: 9,
      params: expect.objectContaining({
        preset_id: 'remove-background-video',
        preset_input_upload_ids: ['upload-video-cutout'],
        source_frame_count: 90,
      }),
    }));
    expect(falDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceVideos: [signedVideo] }),
      'https://mock.example.com/webhooks/fal',
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('remove-background-video: rejects an unreadable owned upload before billing', async () => {
    mockUploadRows([{ id: 'upload-video-broken', r2_key: 'uploads/test-user-id/broken.mp4' }]);
    (probeVideoFrameCount as jest.Mock).mockResolvedValue(null);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'remove-background-video',
      preset_input_upload_ids: ['upload-video-broken'],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MEDIA_PROBE_FAILED');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(falDispatchMock).not.toHaveBeenCalled();
  });

  it('remove-background-video: rejects a missing owned upload before probing or billing', async () => {
    mockUploadRows([]);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'remove-background-video',
      preset_input_upload_ids: ['missing-upload'],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(probeVideoFrameCount).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('enhancer-video: overwrites model to bytedance/video-upscaler, bills computeUpscalerCost from the real duration', async () => {
    mockUploadRows([{ id: 'upload-video', r2_key: 'uploads/test-user-id/clip.mp4' }]);
    (computeUpscalerCost as jest.Mock).mockReturnValue(7);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-enh-video' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-enh-video' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'enhancer-video',
      preset_input_upload_ids: ['upload-video'],
      estimated_duration_seconds: 20,
    });

    expect(res.status).toBe(200);
    expect(computeUpscalerCost).toHaveBeenCalledWith(20, 'standard', '720p', 30);
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ media_type: 'upscale', model: 'bytedance/video-upscaler', cost_credits: 7 }),
    );
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        mediaType: 'upscale',
        upscalerInputVideo: 'https://r2.example.com/signed/uploads/test-user-id/clip.mp4',
      }),
    );
  });

  it('enhancer-image: routes to the recraft-crisp-upscale image path (not the video upscaler), bills computeImageUpscaleCost', async () => {
    mockUploadRows([{ id: 'upload-image', r2_key: 'uploads/test-user-id/photo2.jpg' }]);
    (computeImageUpscaleCost as jest.Mock).mockReturnValue(1);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-enh-image' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-enh-image' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'enhancer-image',
      preset_input_upload_ids: ['upload-image'],
    });

    expect(res.status).toBe(200);
    expect(computeImageUpscaleCost).toHaveBeenCalled();
    expect(computeUpscalerCost).not.toHaveBeenCalled();
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ media_type: 'upscale', model: 'recraft-ai/recraft-crisp-upscale', cost_credits: 1 }),
    );
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        mediaType: 'upscale',
        model: 'recraft-ai/recraft-crisp-upscale',
        upscalerInputImage: 'https://r2.example.com/signed/uploads/test-user-id/photo2.jpg',
      }),
    );
  });

  it('anime-yourself: image path, single reference image mapped, bills computeImageCostCredits', async () => {
    mockUploadRows([{ id: 'upload-anime', r2_key: 'uploads/test-user-id/selfie.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-anime' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-anime' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'anime-yourself',
      preset_input_upload_ids: ['upload-anime'],
    });

    expect(res.status).toBe(200);
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        media_type: 'image',
        model: 'openai/gpt-image-2-medium',
        cost_credits: 5,
        prompt: expect.stringContaining('anime'),
      }),
    );
  });

  it('polaroid: bundled examples precede childhood/adulthood uploads and bills GPT Image 2 medium', async () => {
    mockUploadRows([
      { id: 'upload-p1', r2_key: 'uploads/test-user-id/p1.jpg' },
      { id: 'upload-p2', r2_key: 'uploads/test-user-id/p2.jpg' },
    ]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-polaroid' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-polaroid' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'polaroid',
      preset_input_upload_ids: ['upload-p1', 'upload-p2'],
    });

    expect(res.status).toBe(200);
    expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
      'https://r2.example.com/signed/preset-assets/polaroid/references/example-1.png',
      'https://r2.example.com/signed/preset-assets/polaroid/references/example-2.png',
      'https://r2.example.com/signed/uploads/test-user-id/p1.jpg',
      'https://r2.example.com/signed/uploads/test-user-id/p2.jpg',
    ]);
    expect(computeImageCostCredits).toHaveBeenCalledWith('openai/gpt-image-2-medium');
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        cost_credits: 5,
        params: expect.objectContaining({
          preset_id: 'polaroid',
          preset_input_upload_ids: ['upload-p1', 'upload-p2'],
        }),
      }),
    );
    expect(dispatchMock.mock.calls[0][0].prompt).toContain('image 3 is the person as a child');
    expect(dispatchMock.mock.calls[0][0].prompt).toContain('image 4 is the same person as an adult');
    expect(dispatchMock.mock.calls[0][0].prompt).toContain('chest-up and waist-up compositions');
    expect(dispatchMock.mock.calls[0][0].prompt).toContain('smirk or smile with their teeth showing');
  });

  it('animate-old-photo: video path, fixed duration from the preset max_seconds cap (no user duration slot)', async () => {
    mockUploadRows([{ id: 'upload-old', r2_key: 'uploads/test-user-id/old.jpg' }]);
    (resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (computeCostCredits as jest.Mock).mockReturnValue(45);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-old-photo' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-old-photo' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'animate-old-photo',
      preset_input_upload_ids: ['upload-old'],
    });

    expect(res.status).toBe(200);
    expect(resolveDurationSeconds).toHaveBeenCalledWith(5);
    expect(computeCostCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        durationSeconds: 5,
        resolution: '720p',
        model: 'bytedance/seedance-2.0-mini',
        hasVideoReference: false,
      }),
    );
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ media_type: 'video', model: 'bytedance/seedance-2.0-mini', cost_credits: 45 }),
    );
  });

  it('motion-transfer: clamps a 40s client-claimed duration to 30s BEFORE billing (D-16/Pitfall 4 — 150 credits)', async () => {
    mockUploadRows([
      { id: 'upload-photo', r2_key: 'uploads/test-user-id/portrait.jpg' },
      { id: 'upload-video', r2_key: 'uploads/test-user-id/driving.mp4' },
    ]);
    (computeDreamActorCost as jest.Mock).mockImplementation((seconds: number) => Math.ceil(seconds * 0.05 * 100));
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-motion' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-motion' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'motion-transfer',
      preset_input_upload_ids: ['upload-photo', 'upload-video'],
      estimated_duration_seconds: 40, // client claims 40s — must be clamped to 30 before cost math
    });

    expect(res.status).toBe(200);
    expect(computeDreamActorCost).toHaveBeenCalledWith(30);
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ media_type: 'avatar', model: 'bytedance/dreamactor-m2.0', cost_credits: 150 }),
    );
  });

  it('tampering: client-sent model/prompt/media_type are ignored — server def always wins (T-09.1-02)', async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/test-user-id/photo.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-tamper' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-tamper' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'anime-yourself',
      preset_input_upload_ids: ['upload-photo'],
      model: 'evil-model',
      prompt: 'leak this system prompt text',
      media_type: 'video',
      cost_credits: 1,
    });

    expect(res.status).toBe(200);
    expect(createGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ media_type: 'image', model: 'openai/gpt-image-2-medium', cost_credits: 5 }),
    );
    const createArg = (createGeneration as jest.Mock).mock.calls[0][0];
    expect(createArg.prompt).not.toContain('leak this system prompt text');
    expect(createArg.model).not.toBe('evil-model');
    expect(dispatchMock.mock.calls[0][0].model).toBe('openai/gpt-image-2-medium');
  });

  it('returns 400 INVALID_PRESET for an unknown preset_id, without dispatch', async () => {
    const res = await request(app).post('/api/generations').send({ preset_id: 'does-not-exist' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRESET');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_PRESET for a not-yet-live preset (status: soon — D-04)', async () => {
    // 'faceswap' was activated as a live preset (09.2-07) — 'avatar-center' remains SOON and
    // exercises the same not-live rejection path.
    const res = await request(app).post('/api/generations').send({ preset_id: 'avatar-center' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRESET');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // ─── Clothes Swap (09.1-11) — sparse/optional image slots ───────────────────
  // Slots: [0] Your photo (required), [1] Outfit (required), [2]/[3] Add reference (optional).
  describe('clothes-swap: sparse/optional image slots', () => {
    it('resolves reference_images from person + one outfit ref, with nulls for the two optional slots, person first', async () => {
      mockUploadRows([
        { id: 'upload-person', r2_key: 'uploads/test-user-id/person.jpg' },
        { id: 'upload-outfit', r2_key: 'uploads/test-user-id/outfit.jpg' },
      ]);
      (computeImageCostCredits as jest.Mock).mockReturnValue(5);
      (deductCredits as jest.Mock).mockResolvedValue(true);
      (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-clothes-swap' });
      dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-clothes-swap' });
      (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'clothes-swap',
        preset_input_upload_ids: ['upload-person', 'upload-outfit', null, null],
      });

      expect(res.status).toBe(200);
      expect(createGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ media_type: 'image', model: 'openai/gpt-image-2-medium', cost_credits: 5 }),
      );
      expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
        'https://r2.example.com/signed/uploads/test-user-id/person.jpg',
        'https://r2.example.com/signed/uploads/test-user-id/outfit.jpg',
      ]);
    });

    it('resolves all 4 slots in order when every optional reference is also filled', async () => {
      mockUploadRows([
        { id: 'upload-person', r2_key: 'uploads/test-user-id/person.jpg' },
        { id: 'upload-outfit', r2_key: 'uploads/test-user-id/outfit.jpg' },
        { id: 'upload-extra1', r2_key: 'uploads/test-user-id/extra1.jpg' },
        { id: 'upload-extra2', r2_key: 'uploads/test-user-id/extra2.jpg' },
      ]);
      (computeImageCostCredits as jest.Mock).mockReturnValue(5);
      (deductCredits as jest.Mock).mockResolvedValue(true);
      (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-clothes-swap-full' });
      dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-clothes-swap-full' });
      (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'clothes-swap',
        preset_input_upload_ids: ['upload-person', 'upload-outfit', 'upload-extra1', 'upload-extra2'],
      });

      expect(res.status).toBe(200);
      expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
        'https://r2.example.com/signed/uploads/test-user-id/person.jpg',
        'https://r2.example.com/signed/uploads/test-user-id/outfit.jpg',
        'https://r2.example.com/signed/uploads/test-user-id/extra1.jpg',
        'https://r2.example.com/signed/uploads/test-user-id/extra2.jpg',
      ]);
    });

    it('returns 400 INVALID_PRESET_INPUT when the required Outfit slot (index 1) is missing, without dispatch or billing', async () => {
      mockUploadRows([{ id: 'upload-person', r2_key: 'uploads/test-user-id/person.jpg' }]);
      (computeImageCostCredits as jest.Mock).mockReturnValue(5);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'clothes-swap',
        preset_input_upload_ids: ['upload-person', null, null, null],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRESET_INPUT');
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(createGeneration).not.toHaveBeenCalled();
      expect(deductCredits).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_PRESET_INPUT when the required person slot (index 0) is missing', async () => {
      mockUploadRows([{ id: 'upload-outfit', r2_key: 'uploads/test-user-id/outfit.jpg' }]);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'clothes-swap',
        preset_input_upload_ids: [null, 'upload-outfit', null, null],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRESET_INPUT');
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('regression: hairstyle (no optional slots declared) is unaffected by the sparse-slot validation', async () => {
      mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/test-user-id/photo.jpg' }]);
      (computeImageCostCredits as jest.Mock).mockReturnValue(5);
      (deductCredits as jest.Mock).mockResolvedValue(true);
      (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-hairstyle-regression' });
      dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-hairstyle-regression' });
      (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'hairstyle',
        style_id: 'bob',
        preset_input_upload_ids: ['upload-photo'],
      });

      // Every hairstyle style now ships a thumb_url (style-reference image) — the sparse-slot
      // validation itself is what this test guards (a single required-slot preset with no
      // optional slots declared must dispatch normally), not whether an extra reference image
      // is attached; that part is asserted by the earlier "expands template" test above.
      expect(res.status).toBe(200);
      expect(dispatchMock.mock.calls[0][0].referenceImages).toEqual([
        'https://r2.example.com/signed/uploads/test-user-id/photo.jpg',
        'https://pub-cec5aa79de50452fa7eac827a03d7e04.r2.dev/presets/hairstyle/styles/bob-v1.jpg',
      ]);
    });
  });

  // Preset Sheet Redesign: the new aspect-ratio chips (Hairstyle/Anime Yourself/Polaroid,
  // sheet.aspect_ratios) submit the selected value as the same top-level `image_aspect_ratio`
  // field the freeform composer already uses. presetResolver's 'image' branch only sets
  // `reference_images` — it never touches/strips `image_aspect_ratio` — so prepareCost's image
  // branch (unchanged) reads the client-sent value straight through to dispatch. This test
  // verifies that existing wiring actually holds end-to-end for a preset-originated request.
  it('forwards the client-selected image_aspect_ratio to dispatch for a GPT-Image-2 preset (hairstyle)', async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/test-user-id/photo.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-hairstyle-ar' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-hairstyle-ar' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'hairstyle',
      style_id: 'bob',
      preset_input_upload_ids: ['upload-photo'],
      image_aspect_ratio: '2:3',
    });

    expect(res.status).toBe(200);
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ mediaType: 'image', model: 'openai/gpt-image-2-medium', imageAspectRatio: '2:3' }),
    );
  });

  it('defaults to 1:1 when the client omits image_aspect_ratio for a preset dispatch', async () => {
    mockUploadRows([{ id: 'upload-anime', r2_key: 'uploads/test-user-id/selfie.jpg' }]);
    (computeImageCostCredits as jest.Mock).mockReturnValue(5);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-anime-ar-default' });
    dispatchMock.mockResolvedValue({ providerPredictionId: 'pred-anime-ar-default' });
    (attachPredictionId as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'anime-yourself',
      preset_input_upload_ids: ['upload-anime'],
    });

    expect(res.status).toBe(200);
    expect(dispatchMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ imageAspectRatio: '1:1' }),
    );
  });

  it('returns 400 INVALID_STYLE when style_id does not match the preset style_grid', async () => {
    mockUploadRows([{ id: 'upload-photo', r2_key: 'uploads/test-user-id/photo.jpg' }]);

    const res = await request(app).post('/api/generations').send({
      preset_id: 'hairstyle',
      style_id: 'not-a-real-style',
      preset_input_upload_ids: ['upload-photo'],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STYLE');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // ─── Magic Editor (09.2-08) — mask_upload_id resolution (T-09.2-17: ownership-scoped) ───
  describe('magic-editor: mask_upload_id resolution', () => {
    it('resolves source image + mask to presigned URLs, passes client prompt through, enqueues async magic-editor job', async () => {
      // Regression test (2026-07-11): the iOS client sends the user's typed edit instructions as
      // `prompt` (GenerationRequestBody's CodingKeys has no `text` key). presetResolver used to
      // read `req.body.text` instead, which is never sent — every magic-editor submission was
      // silently rejected with INVALID_PROMPT before createGeneration ever ran (confirmed: zero
      // magic-editor rows existed in prod). This test previously sent `text:` here too, which
      // matched the bug instead of the real client contract and masked it. Must send `prompt`.
      mockUploadRowsSequence(
        [{ id: 'upload-source', r2_key: 'uploads/test-user-id/source.jpg' }],
        [{ id: 'upload-mask', r2_key: 'uploads/test-user-id/mask.png' }],
      );
      (computeImageCostCredits as jest.Mock).mockReturnValue(5);
      (deductCredits as jest.Mock).mockResolvedValue(true);
      (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-magic-1' });

      const res = await request(app).post('/api/generations').send({
        preset_id: 'magic-editor',
        preset_input_upload_ids: ['upload-source'],
        mask_upload_id: 'upload-mask',
        prompt: '  make the sky purple  ',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ generation_id: 'gen-magic-1', status: 'processing' });
      expect(createGeneration).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          preset_id: 'magic-editor',
          preset_input_upload_ids: ['upload-source'],
          mask_upload_id: 'upload-mask',
        }),
      }));
      expect(computeImageCostCredits).toHaveBeenCalledWith('openai/gpt-image-2-medium');
      // The resolved (presigned) source + mask URLs and trimmed client text flow into the job payload.
      expect(openaiGenerationQueue.add).toHaveBeenCalledWith('generate', {
        kind: 'magic-editor',
        generationId: 'gen-magic-1',
        userId: 'test-user-id',
        cost: 5,
        sourceImage: 'https://r2.example.com/signed/uploads/test-user-id/source.jpg',
        maskUrl: 'https://r2.example.com/signed/uploads/test-user-id/mask.png',
        prompt: 'make the sky purple',
      });
      expect(generateImageEditWithMask).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(attachPredictionId).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_PRESET_INPUT when mask_upload_id is missing', async () => {
      mockUploadRowsSequence([{ id: 'upload-source', r2_key: 'uploads/test-user-id/source.jpg' }]);

      const res = await request(app).post('/api/generations').send({
        preset_id: 'magic-editor',
        preset_input_upload_ids: ['upload-source'],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRESET_INPUT');
      expect(generateImageEditWithMask).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('returns 400 INVALID_PRESET_INPUT when mask_upload_id does not resolve to an owned upload (IDOR guard)', async () => {
      mockUploadRowsSequence(
        [{ id: 'upload-source', r2_key: 'uploads/test-user-id/source.jpg' }],
        [], // mask lookup finds no row owned by this user
      );

      const res = await request(app).post('/api/generations').send({
        preset_id: 'magic-editor',
        preset_input_upload_ids: ['upload-source'],
        mask_upload_id: 'someone-elses-upload',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRESET_INPUT');
      expect(generateImageEditWithMask).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });
  });
});

// ─── POST /api/generations — input validation ─────────────────────────────────

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
  });

  it('returns 400 INVALID_MODEL when model is not in SUPPORTED_MODELS', async () => {
    const res = await request(app)
      .post('/api/generations')
      .send({ ...VALID_BODY, model: 'openai/sora' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODEL');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_RESOLUTION when resolution is not supported', async () => {
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

// ─── GET /api/generations ──────────────────────────────────────────────────────

describe('GET /api/generations', () => {
  const completedItem = {
    id: 'gen-001',
    user_id: 'test-user-id',
    status: 'completed',
    r2_key: 'generations/gen-001.mp4',
    created_at: new Date('2026-06-28T10:00:00Z'),
    prompt: 'a cinematic city',
    model: 'bytedance/seedance-2.0-mini',
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
    model: 'bytedance/seedance-2.0-mini',
    cost_credits: 38,
    params: {},
    replicate_prediction_id: null,
    completed_at: null,
  };

  it('returns 200 with items array; completed items get presigned URL, pending get null', async () => {
    (listGenerations as jest.Mock).mockResolvedValue([completedItem, pendingItem]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].video_url).toBe('https://r2.example.com/presigned');
    expect(getGenerationPresignedUrl).toHaveBeenCalledWith('generations/gen-001.mp4');
    expect(res.body.items[1].video_url).toBeNull();
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

    expect(listGenerations).toHaveBeenCalledWith('test-user-id', undefined, 20);
  });

  it('returns nextCursor when page is exactly at limit', async () => {
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
    expect(res.body.nextCursor).toContain('__');
  });

  // D-11/SC3/T-09.1-03: the expanded server template must never leak through the list endpoint.
  it('nulls prompt for a completed preset row but retains params.preset_id (list)', async () => {
    const presetItem = {
      ...completedItem,
      id: 'gen-preset-1',
      prompt: 'the full expanded server template that must never leak to the client',
      params: { preset_id: 'hairstyle', preset_input_upload_ids: ['upload-1'] },
    };
    (listGenerations as jest.Mock).mockResolvedValue([presetItem]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items[0].prompt).toBeNull();
    expect(res.body.items[0].params.preset_id).toBe('hairstyle');
    expect(res.body.items[0].params.preset_input_upload_ids).toEqual(['upload-1']);
  });

  it('returns the user-authored Magic Editor prompt without exposing other preset templates (list)', async () => {
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([
          {
            id: 'upload-source',
            user_id: 'test-user-id',
            r2_key: 'uploads/source.jpg',
            mime_type: 'image/jpeg',
          },
          {
            id: 'upload-mask',
            user_id: 'test-user-id',
            r2_key: 'uploads/mask.png',
            mime_type: 'image/png',
          },
        ]),
      })),
    });
    (listGenerations as jest.Mock).mockResolvedValue([{
      ...completedItem,
      id: 'gen-magic-editor',
      prompt: 'Replace the sign with a neon Fantasia logo',
      params: {
        preset_id: 'magic-editor',
        preset_input_upload_ids: ['upload-source'],
        mask_upload_id: 'upload-mask',
      },
    }]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items[0].prompt).toBe('Replace the sign with a neon Fantasia logo');
    expect(res.body.items[0].params).toEqual({
      preset_id: 'magic-editor',
      preset_input_upload_ids: ['upload-source'],
      mask_upload_id: 'upload-mask',
    });
    expect(res.body.items[0].preset_input_urls).toEqual([{
      url: expect.stringContaining('uploads/source.jpg'),
      isVideo: false,
    }]);
    expect(res.body.items[0].magic_editor_mask_url).toEqual(expect.stringContaining('uploads/mask.png'));
  });

  // D-F + D-G (09.2-13): a faceswap row is reported as media_type 'image' with model nulled and
  // params stripped to preset_id + preset_input_upload_ids — no model/infra/R2 URLs leak (list).
  it('serializes a faceswap preset row as media_type image, model null, minimal params (list)', async () => {
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([
          { id: 'upload-face', user_id: 'test-user-id', r2_key: 'uploads/face.jpg', mime_type: 'image/jpeg' },
          { id: 'upload-target', user_id: 'test-user-id', r2_key: 'uploads/target.jpg', mime_type: 'image/jpeg' },
        ]),
      })),
    });
    const faceswapItem = {
      ...completedItem,
      id: 'gen-faceswap-ser',
      media_type: 'faceswap',
      model: 'openai/gpt-image-2-medium',
      prompt: null,
      r2_key: 'generations/gen-faceswap-ser.png',
      params: {
        preset_id: 'faceswap',
        preset_input_upload_ids: ['upload-face', 'upload-target'],
        swap_image: 'https://r2.example.com/leak-swap.png',
        target_image: 'https://r2.example.com/leak-target.png',
        hair_source: 'target',
      },
    };
    (listGenerations as jest.Mock).mockResolvedValue([faceswapItem]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row.media_type).toBe('image');
    expect(row.model).toBeNull();
    expect(row.params).toEqual({
      preset_id: 'faceswap',
      preset_input_upload_ids: ['upload-face', 'upload-target'],
    });
    // Infra must not leak.
    expect(row.params.swap_image).toBeUndefined();
    expect(row.params.target_image).toBeUndefined();
    expect(row.preset_input_urls).toEqual([
      { url: expect.stringContaining('uploads/face.jpg'), isVideo: false },
      { url: expect.stringContaining('uploads/target.jpg'), isVideo: false },
    ]);
  });

  // T-09.6-13: the server-only chain descriptor (prompts, models, duration) must never reach the
  // client — presetSafeSerialization strips ANY preset row's params to just preset_id +
  // preset_input_upload_ids, so params.chain is dropped along with everything else (list).
  it('never leaks params.chain for a you-vs-you chain preset row (list)', async () => {
    const chainItem = {
      ...completedItem,
      id: 'gen-chain-ser',
      media_type: 'chain',
      model: 'alibaba/happyhorse-1.1',
      prompt: null,
      r2_key: 'generations/gen-chain-ser.mp4',
      params: {
        preset_id: 'you-vs-you',
        preset_input_upload_ids: ['upload-selfie'],
        postprocess: { op: 'mux', audio_r2_key: 'audio/uvu-default.mp3' },
        chain: {
          image_stage: { model: 'wan-video/wan-2.7-image', quality: 'high', prompts: ['secret keyframe prompt one', 'secret keyframe prompt two'] },
          animate_stage: { model: 'alibaba/happyhorse-1.1', resolution: '720p', duration: 8, aspect_ratio: '9:16', prompt_template: 'secret choreography prompt' },
        },
      },
    };
    (listGenerations as jest.Mock).mockResolvedValue([chainItem]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    const row = res.body.items[0];
    expect(row.params).toEqual({
      preset_id: 'you-vs-you',
      preset_input_upload_ids: ['upload-selfie'],
    });
    expect(row.params.chain).toBeUndefined();
    expect(row.params.postprocess).toBeUndefined();
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
    model: 'bytedance/seedance-2.0-mini',
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

  // D-11/SC3/T-09.1-03: the expanded server template must never leak through the detail endpoint.
  it('nulls prompt for a completed preset row but retains params.preset_id (detail)', async () => {
    (getGenerationById as jest.Mock).mockResolvedValue({
      ...completedGen,
      prompt: 'the full expanded server template that must never leak to the client',
      params: { preset_id: 'hairstyle', preset_input_upload_ids: ['upload-1'] },
    });

    const res = await request(app).get('/api/generations/gen-001');

    expect(res.status).toBe(200);
    expect(res.body.prompt).toBeNull();
    expect(res.body.params.preset_id).toBe('hairstyle');
    expect(res.body.params.preset_input_upload_ids).toEqual(['upload-1']);
  });

  it('returns the user-authored Magic Editor prompt from the detail endpoint', async () => {
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([
          {
            id: 'upload-source',
            user_id: 'test-user-id',
            r2_key: 'uploads/source.jpg',
            mime_type: 'image/jpeg',
          },
          {
            id: 'upload-mask',
            user_id: 'test-user-id',
            r2_key: 'uploads/mask.png',
            mime_type: 'image/png',
          },
        ]),
      })),
    });
    (getGenerationById as jest.Mock).mockResolvedValue({
      ...completedGen,
      prompt: 'Remove the person in the background',
      params: {
        preset_id: 'magic-editor',
        preset_input_upload_ids: ['upload-source'],
        mask_upload_id: 'upload-mask',
      },
    });

    const res = await request(app).get('/api/generations/gen-001');

    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe('Remove the person in the background');
    expect(res.body.params).toEqual({
      preset_id: 'magic-editor',
      preset_input_upload_ids: ['upload-source'],
      mask_upload_id: 'upload-mask',
    });
    expect(res.body.preset_input_urls).toEqual([{
      url: expect.stringContaining('uploads/source.jpg'),
      isVideo: false,
    }]);
    expect(res.body.magic_editor_mask_url).toEqual(expect.stringContaining('uploads/mask.png'));
  });

  // D-F + D-G (09.2-13): faceswap detail row → media_type image, model null, minimal params.
  it('serializes a faceswap preset row as media_type image, model null, minimal params (detail)', async () => {
    (getGenerationById as jest.Mock).mockResolvedValue({
      ...completedGen,
      media_type: 'faceswap',
      model: 'openai/gpt-image-2-medium',
      prompt: null,
      r2_key: 'generations/gen-faceswap-ser.png',
      params: {
        preset_id: 'faceswap',
        preset_input_upload_ids: ['upload-face', 'upload-target'],
        swap_image: 'https://r2.example.com/leak-swap.png',
        target_image: 'https://r2.example.com/leak-target.png',
        hair_source: 'target',
      },
    });

    const res = await request(app).get('/api/generations/gen-001');

    expect(res.status).toBe(200);
    expect(res.body.media_type).toBe('image');
    expect(res.body.model).toBeNull();
    expect(res.body.params).toEqual({
      preset_id: 'faceswap',
      preset_input_upload_ids: ['upload-face', 'upload-target'],
    });
    expect(res.body.params.swap_image).toBeUndefined();
    expect(res.body.params.target_image).toBeUndefined();
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

  it('returns 404 when softDeleteGeneration returns false (IDOR guard)', async () => {
    (softDeleteGeneration as jest.Mock).mockResolvedValue(false);

    const res = await request(app).delete('/api/generations/other-user-gen');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found or not authorized');
  });
});

// ─── POST /api/generations — preset postprocess merge (09.3-05) ─────────────
// Uses an isolated module registry (jest.resetModules + jest.doMock('../../config/presets', ...))
// with ONE test-only preset row carrying `postprocess` — the real first-registry-drop rows land
// in 09.3-06/07 (this plan only wires the merge mechanism, see 09.3-05-PLAN.md's "do not flip
// gorilla live or add the 8-row drop here"). Everything else (SERVER_PRESETS) is the REAL
// registry via jest.requireActual, so presetResolver/prepareCost validation is exercised exactly
// as production would. This describe block is LAST in the file — jest.resetModules() in afterAll
// only affects requires made after it (none), so it cannot leak into earlier describes above.
describe('POST /api/generations — preset postprocess merge (09.3-05)', () => {
  const TEST_POSTPROCESS_PRESET = {
    preset_id: 'test-postprocess-preset',
    title: 'Test Postprocess Preset',
    section: 'video_effects',
    sort_order: 9999,
    status: 'live',
    media_type: 'video',
    model: 'bytedance/seedance-2.0-mini',
    prompt_template: 'a test prompt',
    postprocess: { op: 'mux', audio_r2_key: 'audio/trend.m4a' },
    input_schema: { slots: [] },
    cost: { type: 'per_second', credits_per_sec: 8, max_seconds: 5 },
    tile: { poster_url: 'https://x.example/poster.jpg', loop_url: 'https://x.example/loop.mp4' },
  };

  let isolatedApp: express.Express;
  let localCreateGeneration: jest.Mock;
  let localDb: { execute: jest.Mock };

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../config/presets', () => {
      const actual = jest.requireActual('../../config/presets');
      return { ...actual, SERVER_PRESETS: [...actual.SERVER_PRESETS, TEST_POSTPROCESS_PRESET] };
    });

    localDb = require('../../db/client').db;
    localDb.execute.mockResolvedValue({ rows: [] });

    const freshCreditService = require('../../services/creditService');
    (freshCreditService.deductCredits as jest.Mock).mockResolvedValue(true);

    const freshGenerationService = require('../../services/generationService');
    (freshGenerationService.resolveDurationSeconds as jest.Mock).mockReturnValue(5);
    (freshGenerationService.computeCostCredits as jest.Mock).mockReturnValue(40);
    localCreateGeneration = freshGenerationService.createGeneration as jest.Mock;
    localCreateGeneration.mockResolvedValue({ id: 'gen-postprocess-1' });

    const freshReplicateProviderModule = require('../../services/providers/ReplicateProvider');
    const FreshCtor = freshReplicateProviderModule.ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;

    const { generationsRouter: freshRouter } = require('../../routes/generations');

    const freshDispatch = FreshCtor.mock.results[0]?.value?.dispatch as jest.Mock;
    freshDispatch.mockResolvedValue({ providerPredictionId: 'pred-postprocess-1' });

    isolatedApp = express();
    isolatedApp.use(express.json());
    isolatedApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { dbUserId: 'test-user-id', uid: 'fb-uid', email: 't@test.com' };
      next();
    });
    isolatedApp.use('/api/generations', freshRouter);
  });

  afterAll(() => {
    jest.dontMock('../../config/presets');
    jest.resetModules();
  });

  it('merges def.postprocess onto rowParams.postprocess when the resolved preset declares one', async () => {
    const res = await request(isolatedApp).post('/api/generations').send({
      preset_id: 'test-postprocess-preset',
      preset_input_upload_ids: [],
    });

    expect(res.status).toBe(200);
    expect(localCreateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          postprocess: { op: 'mux', audio_r2_key: 'audio/trend.m4a' },
        }),
      }),
    );
  });
});
