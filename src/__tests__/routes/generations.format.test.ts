// Format generation route contracts (Phase 14 Plan 06). Config must be mocked before imports.
jest.mock('../../config', () => ({
  config: {
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'mock',
    firebaseProjectId: 'mock',
    firebaseClientEmail: 'mock@example.com',
    firebasePrivateKey: 'mock',
    apnsAuthKey: 'mock',
    apnsKeyId: 'mock',
    apnsTeamId: 'mock',
    apnsBundleId: 'mock',
    replicateApiToken: 'mock',
    replicateWebhookSecret: 'mock',
    openaiApiKey: 'mock',
    publicBaseUrl: 'https://mock.example.com',
    port: 3000,
    nodeEnv: 'test',
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
  getFalWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/fal'),
}));

jest.mock('../../db/client', () => ({
  db: {
    select: jest.fn(),
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
  resolveFalKlingV3Duration: jest.fn(),
  computeHappyHorseCost: jest.fn(),
  resolveHappyHorseDuration: jest.fn(),
  computeCharacterReplaceCost: jest.fn(),
  computeCharacterReplaceProCost: jest.fn(),
  computeFaceswapCost: jest.fn(),
  computeChainCost: jest.fn(),
  createGeneration: jest.fn(),
  attachPredictionId: jest.fn(),
  markFailed: jest.fn(),
  listGenerations: jest.fn(),
  getGenerationById: jest.fn(),
  softDeleteGeneration: jest.fn(),
  setGenerationFavorite: jest.fn(),
  classifyFailureReason: jest.fn(() => 'generic_error'),
  SUPPORTED_MODELS: [],
  MODEL_RESOLUTIONS: {},
  SUPPORTED_IMAGE_MODELS: [],
  SUPPORTED_AVATAR_MODELS: [],
  SUPPORTED_UPSCALER_MODELS: [],
  SUPPORTED_IMAGE_UPSCALE_MODELS: [],
  SUPPORTED_GROK_MODELS: [],
  SUPPORTED_FAL_KLING_MODELS: [],
  SUPPORTED_HAPPYHORSE_MODELS: [],
  SUPPORTED_CHARACTER_REPLACE_MODELS: [],
  SUPPORTED_FACESWAP_MODELS: [],
}));

jest.mock('../../services/providers/ReplicateProvider', () => ({
  ReplicateProvider: jest.fn().mockImplementation(() => ({ dispatch: jest.fn() })),
}));
jest.mock('../../services/providers/FalProvider', () => ({
  FalProvider: jest.fn().mockImplementation(() => ({ dispatch: jest.fn() })),
}));
jest.mock('../../services/archivalService', () => ({
  getGenerationPresignedUrl: jest.fn(),
  getUploadPresignedUrl: jest.fn(),
}));

jest.mock('../../queue/openaiGenerationQueue', () => ({
  openaiGenerationQueue: { add: jest.fn() },
}));
jest.mock('../../queue/chainGenerationQueue', () => ({
  chainGenerationQueue: { add: jest.fn() },
}));
jest.mock('../../queue/influencerProQueue', () => ({
  influencerProQueue: { add: jest.fn() },
}));
jest.mock('../../queue/explainerGenerationQueue', () => ({
  explainerGenerationQueue: { add: jest.fn() },
}));
jest.mock('../../queue/falImageToolQueue', () => ({
  falImageToolQueue: { add: jest.fn() },
}));

jest.mock('../../middleware/presetResolver', () => ({
  presetResolver: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/celebrityCheck', () => ({
  celebrityCheckMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/inputMediaGate', () => ({
  inputMediaGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/entitlementGate', () => ({
  entitlementGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/concurrencyGate', () => ({
  concurrencyGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { generationsRouter } from '../../routes/generations';
import { db } from '../../db/client';
import { deductCredits, refundCredits } from '../../services/creditService';
import {
  createGeneration,
  listGenerations,
  markFailed,
} from '../../services/generationService';
import { getGenerationPresignedUrl } from '../../services/archivalService';
import { explainerGenerationQueue } from '../../queue/explainerGenerationQueue';
import { promptModerationMiddleware } from '../../middleware/promptModeration';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'user-owned', uid: 'firebase-user', email: 'test@example.com' };
  next();
});
app.use('/api/generations', generationsRouter);

const BASE_BODY = {
  format_id: 'explainer',
  prompt: '  Why do leaves change color?  ',
  style_id: 'pixel-art',
  duration_seconds: 30,
  voice_id: 'Kore',
  music: 'auto',
  aspect_ratio: '9:16',
  // Tampering attempts: the resolver/prepareCost path must overwrite or ignore all three.
  cost_credits: 1,
  media_type: 'video',
  model: 'client/cheap-model',
};

const OTHER_USER_UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const OWNED_IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const OWNED_PDF_ID = '33333333-3333-4333-8333-333333333333';
const OWNED_VIDEO_ID = '44444444-4444-4444-8444-444444444444';

function mockAttachmentRows(rows: Array<{ id: string; r2Key: string; mimeType: string }>): void {
  (db.select as jest.Mock).mockReturnValueOnce({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue(rows),
    })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.select as jest.Mock).mockReturnValue({
    from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
  });
  (deductCredits as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-format' });
  (explainerGenerationQueue.add as jest.Mock).mockResolvedValue(undefined);
});

describe('POST /api/generations — format', () => {
  it('bills exact server registry tiers and ignores client cost, media_type, and model tampering', async () => {
    (createGeneration as jest.Mock)
      .mockResolvedValueOnce({ id: 'gen-30' })
      .mockResolvedValueOnce({ id: 'gen-90' });

    const thirty = await request(app).post('/api/generations').send(BASE_BODY);
    const ninety = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      duration_seconds: 90,
      cost_credits: 1,
      media_type: 'image',
      model: 'client/free-model',
    });

    expect(thirty.status).toBe(200);
    expect(ninety.status).toBe(200);
    expect(deductCredits).toHaveBeenNthCalledWith(1, 'user-owned', 470);
    expect(deductCredits).toHaveBeenNthCalledWith(2, 'user-owned', 1377);
    expect(createGeneration).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: '', media_type: 'format', cost_credits: 470,
    }));
    expect(createGeneration).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: '', media_type: 'format', cost_credits: 1377,
    }));
  });

  it('enqueues only server-resolved job fields and returns the async processing response', async () => {
    const res = await request(app).post('/api/generations').send(BASE_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ generation_id: 'gen-format', status: 'processing' });
    expect(promptModerationMiddleware).toHaveBeenCalledTimes(1);
    expect(explainerGenerationQueue.add).toHaveBeenCalledWith('generate', {
      generationId: 'gen-format',
      userId: 'user-owned',
      cost: 470,
      formatId: 'explainer',
      visualMethod: 'animated',
      topic: 'Why do leaves change color?',
      styleId: 'pixel-art',
      voiceId: 'Kore',
      music: 'auto',
      sceneCount: 4,
      durationSeconds: 30,
      aspectRatio: '9:16',
      attachments: [],
      sourceUrl: null,
    });
  });

  it('rejects every unsupported server-registry choice before deduction or row creation', async () => {
    const cases = [
      [{ ...BASE_BODY, format_id: 'unknown' }, 'INVALID_FORMAT'],
      [{ ...BASE_BODY, style_id: 'unknown' }, 'INVALID_STYLE'],
      [{ ...BASE_BODY, duration_seconds: 25 }, 'INVALID_DURATION'],
      [{ ...BASE_BODY, voice_id: 'UnknownVoice' }, 'INVALID_VOICE'],
      [{ ...BASE_BODY, music: 'heavy-metal' }, 'INVALID_MUSIC'],
      [{ ...BASE_BODY, aspect_ratio: '1:1' }, 'INVALID_ASPECT_RATIO'],
      [{ ...BASE_BODY, prompt: '   ' }, 'INVALID_INPUT'],
      [{ ...BASE_BODY, source_url: 'file:///etc/passwd' }, 'INVALID_INPUT'],
    ] as const;

    for (const [body, code] of cases) {
      const res = await request(app).post('/api/generations').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(explainerGenerationQueue.add).not.toHaveBeenCalled();
  });

  it('rejects client-injected format descriptors when formatResolver did not resolve a format id', async () => {
    const res = await request(app).post('/api/generations').send({
      media_type: 'format',
      prompt: 'attempt descriptor injection',
      cost_credits: 1,
      __format_def: { format_id: 'forged' },
      __format_tier: { seconds: 30, scene_count: 1, credits: 1 },
      __format_inputs: {
        style_id: 'forged',
        topic: 'attempt descriptor injection',
        voice_id: 'forged',
        music: 'none',
        aspectRatio: '9:16',
        attachments: [],
        sourceUrl: null,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
    expect(explainerGenerationQueue.add).not.toHaveBeenCalled();
  });

  it('forwards a valid non-default aspect ratio and defaults an omitted ratio from the format row', async () => {
    (createGeneration as jest.Mock)
      .mockResolvedValueOnce({ id: 'gen-wide' })
      .mockResolvedValueOnce({ id: 'gen-default' });

    const wide = await request(app).post('/api/generations').send({ ...BASE_BODY, aspect_ratio: '16:9' });
    const fallback = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      aspect_ratio: undefined,
    });

    expect(wide.status).toBe(200);
    expect(fallback.status).toBe(200);
    expect((explainerGenerationQueue.add as jest.Mock).mock.calls[0][1].aspectRatio).toBe('16:9');
    expect((explainerGenerationQueue.add as jest.Mock).mock.calls[1][1].aspectRatio).toBe('9:16');
  });

  it('rejects attachment IDOR and max-count violations before billing', async () => {
    mockAttachmentRows([]); // another user's id cannot resolve through the ownership predicate
    const idor = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      attachment_ids: [OTHER_USER_UPLOAD_ID],
    });
    const tooMany = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      attachment_ids: ['one', 'two', 'three', 'four'],
    });

    expect(idor.status).toBe(400);
    expect(idor.body.code).toBe('INVALID_ATTACHMENT');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_ATTACHMENT');

    mockAttachmentRows([
      { id: OWNED_VIDEO_ID, r2Key: 'uploads/user-owned/source.mp4', mimeType: 'video/mp4' },
    ]);
    const unsupportedMime = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      attachment_ids: [OWNED_VIDEO_ID],
    });
    expect(unsupportedMime.status).toBe(400);
    expect(unsupportedMime.body.code).toBe('INVALID_ATTACHMENT');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createGeneration).not.toHaveBeenCalled();
  });

  it('resolves owned attachment ids to trusted R2 key/MIME pairs and normalizes the source URL', async () => {
    mockAttachmentRows([
      { id: OWNED_IMAGE_ID, r2Key: 'uploads/user-owned/source.png', mimeType: 'image/png' },
      { id: OWNED_PDF_ID, r2Key: 'uploads/user-owned/source.pdf', mimeType: 'application/pdf' },
    ]);

    const res = await request(app).post('/api/generations').send({
      ...BASE_BODY,
      attachment_ids: [OWNED_IMAGE_ID, OWNED_PDF_ID],
      source_url: 'https://example.com/research',
    });

    expect(res.status).toBe(200);
    expect(explainerGenerationQueue.add).toHaveBeenCalledWith('generate', expect.objectContaining({
      attachments: [
        { r2Key: 'uploads/user-owned/source.png', mimeType: 'image/png' },
        { r2Key: 'uploads/user-owned/source.pdf', mimeType: 'application/pdf' },
      ],
      sourceUrl: 'https://example.com/research',
    }));
  });

  it('marks failed and refunds the full server tier exactly once when enqueue fails', async () => {
    (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-enqueue-fail' });
    (explainerGenerationQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis unavailable'));

    const res = await request(app).post('/api/generations').send(BASE_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Credits have been refunded');
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith('gen-enqueue-fail', 'generic_error');
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledWith(
      'user-owned', 470, 'dispatch-failure-gen-enqueue-fail',
    );
  });
});

describe('GET /api/generations — format serialization', () => {
  const formatRow = {
    id: 'gen-format-complete',
    user_id: 'user-owned',
    status: 'completed',
    media_type: 'format',
    r2_key: 'generations/gen-format-complete.mp4',
    created_at: new Date('2026-07-17T12:00:00Z'),
    completed_at: new Date('2026-07-17T12:02:00Z'),
    prompt: 'Why do leaves change color?',
    model: '',
    cost_credits: 470,
    replicate_prediction_id: null,
    params: {
      format_id: 'explainer',
      stage_label: 'Rendering…',
      structured: {
        audioStems: [{
          r2Key: 'generations/gen-format-complete.narration.wav',
          sourceType: 'narration',
        }],
        captionCues: [{
          startSeconds: 0,
          endSeconds: 1,
          words: [{ text: 'Leaves', startSeconds: 0, endSeconds: 1 }],
        }],
      },
    },
  };

  it('strips structured stems/cues and raw R2 keys while preserving the completed public row', async () => {
    (listGenerations as jest.Mock).mockResolvedValue([formatRow]);
    (getGenerationPresignedUrl as jest.Mock).mockResolvedValue('https://r2.example.com/final-video');

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.id).toBe('gen-format-complete');
    expect(item.status).toBe('completed');
    expect(item.video_url).toBe('https://r2.example.com/final-video');
    expect(item.params).toEqual({ format_id: 'explainer', stage_label: 'Rendering…' });
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain('structured');
    expect(serialized).not.toContain('audioStems');
    expect(serialized).not.toContain('narration.wav');
  });

  it('allows only format_id and stage_label through for an in-progress format row', async () => {
    (listGenerations as jest.Mock).mockResolvedValue([{
      ...formatRow,
      id: 'gen-format-processing',
      status: 'processing',
      r2_key: null,
      completed_at: null,
      params: {
        ...formatRow.params,
        stage_label: 'Animating…',
        internal_debug: 'must-not-leak',
      },
    }]);

    const res = await request(app).get('/api/generations');

    expect(res.status).toBe(200);
    expect(res.body.items[0].video_url).toBeNull();
    expect(res.body.items[0].params).toEqual({
      format_id: 'explainer',
      stage_label: 'Animating…',
    });
  });
});
