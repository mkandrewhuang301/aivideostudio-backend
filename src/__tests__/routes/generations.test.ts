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
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
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
  computeGrokImagineCost: jest.fn(),
  createGeneration: jest.fn(),
  attachPredictionId: jest.fn(),
  markRefunded: jest.fn(),
  markFailed: jest.fn(),
  markCompleted: jest.fn(),
  markQuarantined: jest.fn(),
  listGenerations: jest.fn(),
  getGenerationById: jest.fn(),
  softDeleteGeneration: jest.fn(),
  SUPPORTED_MODELS: ['bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0'],
  MODEL_RESOLUTIONS: {
    'bytedance/seedance-2.0-mini': ['480p', '720p'],
    'bytedance/seedance-2.0':      ['480p', '720p', '1080p', '4k'],
    'xai/grok-imagine-video-1.5':  ['480p', '720p'],
  },
  SUPPORTED_IMAGE_MODELS: ['openai/gpt-image-2-high', 'openai/gpt-image-2-medium', 'openai/gpt-image-2-low', 'openai/gpt-image-2'],
  SUPPORTED_AVATAR_MODELS: ['bytedance/dreamactor-m2.0'],
  SUPPORTED_UPSCALER_MODELS: ['bytedance/video-upscaler'],
  SUPPORTED_GROK_MODELS: ['xai/grok-imagine-video-1.5'],
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

jest.mock('../../services/openaiImageService', () => ({
  generateImageWithOpenAI: jest.fn(),
}));

jest.mock('../../services/hiveService', () => ({
  scanForCsam: jest.fn(),
}));

jest.mock('../../queue/hiveScanWorker', () => ({
  hiveScanQueue: {
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

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { generationsRouter } from '../../routes/generations';
import { deductCredits, refundCredits } from '../../services/creditService';
import {
  resolveDurationSeconds,
  computeCostCredits,
  computeImageCostCredits,
  computeGrokImagineCost,
  createGeneration,
  attachPredictionId,
  listGenerations,
  getGenerationById,
  softDeleteGeneration,
  markRefunded,
  markFailed,
  markCompleted,
  markQuarantined,
} from '../../services/generationService';
import { getGenerationPresignedUrl, getUploadPresignedUrl } from '../../services/archivalService';
import { generateImageWithOpenAI } from '../../services/openaiImageService';
import { scanForCsam } from '../../services/hiveService';
import { hiveScanQueue } from '../../queue/hiveScanWorker';
import { ReplicateProvider } from '../../services/providers/ReplicateProvider';
import { db } from '../../db/client';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

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

// ─── POST /api/generations — openai/gpt-image-2 (inline path) ────────────────

// Skipped: generateImageWithOpenAI() (openaiImageService.ts) is not yet wired into the route.
// See .planning/STATE.md — direct-to-OpenAI routing is future work, currently gpt-image-2 dispatches via Replicate.
describe.skip('POST /api/generations — openai/gpt-image-2 (inline)', () => {
  const GPT_BODY = {
    prompt: 'a red rose in a glass vase',
    media_type: 'image',
    model: 'openai/gpt-image-2',
  };

  it('calls generateImageWithOpenAI, marks completed, never calls Replicate dispatch', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-openai-1' });
    (generateImageWithOpenAI as jest.Mock).mockResolvedValue('generations/gen-openai-1.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
    (markCompleted as jest.Mock).mockResolvedValue(true);

    const res = await request(app).post('/api/generations').send(GPT_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-openai-1', status: 'processing' });
    expect(generateImageWithOpenAI).toHaveBeenCalledWith('a red rose in a glass vase', '1:1', 'gen-openai-1');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(attachPredictionId).not.toHaveBeenCalled();
    expect(markCompleted).toHaveBeenCalledWith('gen-openai-1', 'generations/gen-openai-1.png');
  });

  it('uses the image_aspect_ratio sent by the client', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-openai-ar' });
    (generateImageWithOpenAI as jest.Mock).mockResolvedValue('generations/gen-openai-ar.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
    (markCompleted as jest.Mock).mockResolvedValue(true);

    await request(app).post('/api/generations').send({ ...GPT_BODY, image_aspect_ratio: '16:9' });

    expect(generateImageWithOpenAI).toHaveBeenCalledWith(
      expect.any(String),
      '16:9',
      expect.any(String),
    );
  });

  it('OpenAI API failure returns 502 with refund, never marks completed', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-openai-fail' });
    (generateImageWithOpenAI as jest.Mock).mockRejectedValue(new Error('OpenAI 429 rate limit'));
    (markFailed as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(GPT_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledWith('gen-openai-fail');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      13,
      'dispatch-failure-gen-openai-fail',
    );
    expect(markCompleted).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('CSAM scan flagged: quarantines and refunds without exposing URL', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-openai-csam' });
    (generateImageWithOpenAI as jest.Mock).mockResolvedValue('generations/gen-openai-csam.png');
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: true });
    (markQuarantined as jest.Mock).mockResolvedValue(true);
    (refundCredits as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/generations').send(GPT_BODY);

    expect(res.status).toBe(200);
    expect(markQuarantined).toHaveBeenCalledWith('gen-openai-csam');
    expect(refundCredits).toHaveBeenCalledWith(
      'test-user-id',
      13,
      'csam-quarantine-openai-gen-openai-csam',
    );
    expect(markCompleted).not.toHaveBeenCalled();
  });

  it('CSAM scan error queues hiveScanWorker retry, does NOT mark completed or quarantined', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(true);
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-openai-hive-err' });
    (generateImageWithOpenAI as jest.Mock).mockResolvedValue('generations/gen-openai-hive-err.png');
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    const res = await request(app).post('/api/generations').send(GPT_BODY);

    expect(res.status).toBe(200);
    expect(hiveScanQueue.add).toHaveBeenCalledWith('scan', {
      generationId: 'gen-openai-hive-err',
      r2Key: 'generations/gen-openai-hive-err.png',
      userId: 'test-user-id',
      costCredits: 13,
    });
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markQuarantined).not.toHaveBeenCalled();
  });

  it('insufficient credits for gpt-image-2 returns 402 without calling OpenAI', async () => {
    (computeImageCostCredits as jest.Mock).mockReturnValue(13);
    (deductCredits as jest.Mock).mockResolvedValue(false);

    const res = await request(app).post('/api/generations').send(GPT_BODY);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(generateImageWithOpenAI).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
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
