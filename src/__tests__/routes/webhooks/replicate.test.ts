// src/__tests__/routes/webhooks/replicate.test.ts
// Unit tests for the Replicate webhook handler.
// Covers: signature verification gate, R2-first archival ordering, idempotent status
// transitions, failure refund path, and isolated best-effort APNs push (CLAUDE.md Rules 2 & 3).
//
// archiveToR2 itself (unmocked fetch/R2 behavior) is covered separately in
// src/__tests__/services/archivalService.test.ts — that module is mocked here so the
// webhook handler's branching logic can be tested in isolation.

// Mock config FIRST — before any module that calls requireEnv() at load time
jest.mock('../../../config', () => ({
  config: {
    replicateWebhookSecret: 'whsec_test-secret',
    hiveScanRealFacePaths: true,
    databaseUrl: 'mock://db',
    redisUrl: 'redis://localhost',
    r2AccountId: 'mock',
    r2AccessKeyId: 'mock',
    r2SecretAccessKey: 'mock',
    r2BucketName: 'test-bucket',
    r2PublicDomain: '',
    firebaseProjectId: 'mock',
    firebaseClientEmail: 'mock@mock.iam.gserviceaccount.com',
    firebasePrivateKey: 'mock-key',
    apnsAuthKey: 'mock-apns-key',
    apnsKeyId: 'mock-key-id',
    apnsTeamId: 'mock-team-id',
    apnsBundleId: 'com.mock.bundle',
    replicateApiToken: 'mock-token',
    port: 3000,
    nodeEnv: 'test',
  },
  getReplicateWebhookUrl: jest.fn(() => 'https://mock.example.com/webhooks/replicate'),
}));

const mockValidateWebhook = jest.fn();
jest.mock('replicate', () => ({
  validateWebhook: mockValidateWebhook,
}));

const mockHiveScanQueueAdd = jest.fn();
jest.mock('../../../queue/hiveScanWorker', () => ({
  hiveScanQueue: { add: mockHiveScanQueueAdd },
}));

const mockFfmpegQueueAdd = jest.fn();
jest.mock('../../../queue/ffmpegWorker', () => ({
  ffmpegQueue: { add: mockFfmpegQueueAdd },
}));

jest.mock('../../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
  getUploadPresignedUrl: jest.fn(),
}));

jest.mock('../../../services/generationService', () => ({
  getGenerationByPredictionId: jest.fn(),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  markQuarantined: jest.fn(),
  reattachForRetry: jest.fn(),
  isTransientProviderError: jest.requireActual('../../../services/generationService').isTransientProviderError,
  classifyFailureReason: jest.requireActual('../../../services/generationService').classifyFailureReason,
  SUPPORTED_MODELS: jest.requireActual('../../../services/generationService').SUPPORTED_MODELS,
  PERMISSIVE_I2V_MODEL: jest.requireActual('../../../services/generationService').PERMISSIVE_I2V_MODEL,
}));

jest.mock('../../../services/hiveService', () => ({
  scanForCsam: jest.fn(),
}));
jest.mock('../../../services/moderationEnforcementService', () => ({
  enforceFlaggedGeneration: jest.fn(),
}));

jest.mock('../../../services/creditService', () => ({
  refundCredits: jest.fn(),
}));

jest.mock('../../../services/apnsService', () => ({
  sendGenerationComplete: jest.fn(),
}));

jest.mock('../../../services/providers/ReplicateProvider', () => ({
  ReplicateProvider: jest.fn().mockImplementation(() => ({
    dispatch: jest.fn(),
  })),
  validateReplicateWebhook: mockValidateWebhook,
}));

jest.mock('../../../storage/r2', () => ({
  r2: { send: jest.fn().mockResolvedValue({}) },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('../../../db/client', () => ({
  db: {
    execute: jest.fn(),
    select: jest.fn(),
    delete: jest.fn(),
  },
}));

import express from 'express';
import request from 'supertest';
import { validateWebhook } from 'replicate';
import { archiveToR2 } from '../../../services/archivalService';
import { getGenerationByPredictionId, markCompleted, markFailed, markQuarantined, reattachForRetry } from '../../../services/generationService';
import { scanForCsam } from '../../../services/hiveService';
import { refundCredits } from '../../../services/creditService';
import { sendGenerationComplete } from '../../../services/apnsService';
import { ReplicateProvider } from '../../../services/providers/ReplicateProvider';
import { db } from '../../../db/client';
import { r2 } from '../../../storage/r2';
import { enforceFlaggedGeneration } from '../../../services/moderationEnforcementService';
import { replicateWebhookRouter } from '../../../routes/webhooks/replicate';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

const dbMock = db as unknown as { execute: jest.Mock; select: jest.Mock; delete: jest.Mock };
const r2Mock = r2 as unknown as { send: jest.Mock };

// select().from().where() chain resolving to the given rows — mirrors uploads.test.ts pattern.
function makeSelectChain(rows: unknown[] = []) {
  return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(rows) }) };
}

const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use('/webhooks/replicate', replicateWebhookRouter);

const HEADERS = {
  'webhook-id': 'msg_1',
  'webhook-timestamp': '1700000000',
  'webhook-signature': 'v1,sig',
};

function post(payload: unknown) {
  return request(app)
    .post('/webhooks/replicate')
    .set(HEADERS)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.execute as jest.Mock).mockResolvedValue({ rows: [{ apns_device_token: 'device-token-1' }] });
  (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-1.mp4');
  (scanForCsam as jest.Mock).mockResolvedValue({ flagged: false });
  (markCompleted as jest.Mock).mockResolvedValue(true);
  (markFailed as jest.Mock).mockResolvedValue(true);
  (markQuarantined as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (sendGenerationComplete as jest.Mock).mockResolvedValue(undefined);
  (reattachForRetry as jest.Mock).mockResolvedValue(true);
  dispatchMock.mockResolvedValue({ providerPredictionId: 'pred_retry_1' });
  dbMock.select.mockReturnValue(makeSelectChain([]));
  dbMock.delete.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  r2Mock.send.mockResolvedValue({});
});

describe('replicateWebhookRouter', () => {
  it('returns 401 and does no downstream work when validateWebhook returns false', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(false);

    const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid webhook signature' });
    expect(getGenerationByPredictionId).not.toHaveBeenCalled();
    expect(archiveToR2).not.toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
  });

  it('archives to R2 before marking completed and sends a push on a valid succeeded payload', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(archiveToR2).toHaveBeenCalledWith('https://replicate.delivery/abc.mp4', 'gen-1', 'video/mp4');
    expect(markCompleted).toHaveBeenCalledWith('gen-1', 'generations/gen-1.mp4');
    expect(scanForCsam).not.toHaveBeenCalled();

    const archiveOrder = (archiveToR2 as jest.Mock).mock.invocationCallOrder[0];
    const completeOrder = (markCompleted as jest.Mock).mock.invocationCallOrder[0];
    expect(archiveOrder).toBeLessThan(completeOrder);

    expect(sendGenerationComplete).toHaveBeenCalledWith('device-token-1', 'gen-1', 'video');
  });

  it('archives an image generation with image/jpeg content-type and sends image push copy', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-img-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 5,
      media_type: 'image',
    });
    (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-img-1.jpg');

    const res = await post({ id: 'pred_img_1', status: 'succeeded', output: ['https://replicate.delivery/flux-out.bin'] });

    expect(res.status).toBe(200);
    expect(archiveToR2).toHaveBeenCalledWith('https://replicate.delivery/flux-out.bin', 'gen-img-1', 'image/jpeg');
    expect(markCompleted).toHaveBeenCalledWith('gen-img-1', 'generations/gen-img-1.jpg');
    expect(sendGenerationComplete).toHaveBeenCalledWith('device-token-1', 'gen-img-1', 'image');
  });

  it('archives an image generation with image/webp content-type when output URL has .webp extension', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-img-2',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 15,
      media_type: 'image',
    });
    (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-img-2.webp');

    const res = await post({ id: 'pred_img_2', status: 'succeeded', output: ['https://replicate.delivery/flux-out.webp'] });

    expect(res.status).toBe(200);
    expect(archiveToR2).toHaveBeenCalledWith('https://replicate.delivery/flux-out.webp', 'gen-img-2', 'image/webp');
  });

  it('returns 200 with duplicate:true and skips all side effects for an already-completed generation', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'completed',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(archiveToR2).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
  });

  it('marks failed and refunds credits on a failed payload', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-2',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_456', status: 'failed' });

    expect(res.status).toBe(200);
    expect(markFailed).toHaveBeenCalledWith('gen-2', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'pred_456');
  });

  it('marks failed with content_policy reason when Replicate error mentions nsfw/safety', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-3',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_nsfw', status: 'failed', error: 'NSFW content detected by safety filter' });

    expect(res.status).toBe(200);
    expect(markFailed).toHaveBeenCalledWith('gen-3', 'content_policy');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'pred_nsfw');
  });

  it('still returns 200 when sendGenerationComplete throws (push failure isolated)', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });
    (sendGenerationComplete as jest.Mock).mockRejectedValue(new Error('APNs down'));

    const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('routes a flagged real-face output through two-tier enforcement', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
      has_real_face_input: true,
    });
    const result = { flagged: true, tier: 'high', childScore: 0.95, sexualScore: 0.9, hashMatched: false };
    (scanForCsam as jest.Mock).mockResolvedValue(result);

    const res = await post({ id: 'pred_csam', status: 'succeeded', output: ['https://replicate.delivery/flagged.mp4'] });

    expect(res.status).toBe(200);
    expect(enforceFlaggedGeneration).toHaveBeenCalledWith({
      generationId: 'gen-1',
      r2Key: 'generations/gen-1.mp4',
      userId: 'u1',
      costCredits: 45,
    }, result);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
  });

  it('queues hiveScanWorker retry when Hive errors — never quarantines or delivers immediately', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
      has_real_face_input: true,
    });
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    const res = await post({ id: 'pred_err', status: 'succeeded', output: ['https://replicate.delivery/video.mp4'] });

    expect(res.status).toBe(200);
    expect(mockHiveScanQueueAdd).toHaveBeenCalledWith('scan', {
      generationId: 'gen-1',
      r2Key: 'generations/gen-1.mp4',
      userId: 'u1',
      costCredits: 45,
      mediaType: 'video',
    });
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  it('queues hiveScanWorker retry with mediaType: image for an image generation — regression guard for the retry path defaulting to the video push copy', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-img-err',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 5,
      media_type: 'image',
      has_real_face_input: true,
    });
    (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-img-err.jpg');
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    const res = await post({ id: 'pred_img_err', status: 'succeeded', output: ['https://replicate.delivery/flux-out.bin'] });

    expect(res.status).toBe(200);
    expect(mockHiveScanQueueAdd).toHaveBeenCalledWith('scan', {
      generationId: 'gen-img-err',
      r2Key: 'generations/gen-img-err.jpg',
      userId: 'u1',
      costCredits: 5,
      mediaType: 'image',
    });
  });

  it('returns 200 with duplicate:true when status is already quarantined', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'quarantined',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(archiveToR2).not.toHaveBeenCalled();
    expect(scanForCsam).not.toHaveBeenCalled();
  });

  it('marks failed and refunds when succeeded payload has no output URL', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });

    const res = await post({ id: 'pred_no_output', status: 'succeeded', output: [] });

    expect(res.status).toBe(200);
    expect(markFailed).toHaveBeenCalledWith('gen-1');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'pred_no_output');
    expect(archiveToR2).not.toHaveBeenCalled();
  });

  it('returns skipped:generation_not_found when prediction_id has no matching generation', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue(null);

    const res = await post({ id: 'pred_unknown', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, skipped: 'generation_not_found' });
    expect(archiveToR2).not.toHaveBeenCalled();
  });

  describe('postprocess -> ffmpegQueue enqueue (09.3 SC1)', () => {
    it('enqueues ffmpegQueue for a mux postprocess generation and does NOT markCompleted', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-postprocess-1',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 27,
        media_type: 'video',
        params: { postprocess: { op: 'mux', audio_r2_key: 'assets/trend-audio/love-island.m4a' } },
      });
      (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-postprocess-1.mp4');

      const res = await post({ id: 'pred_postprocess_1', status: 'succeeded', output: ['https://replicate.delivery/clip.mp4'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, postprocess: 'mux' });
      expect(mockFfmpegQueueAdd).toHaveBeenCalledWith('postprocess', {
        generationId: 'gen-postprocess-1',
        userId: 'u1',
        costCredits: 27,
        op: 'mux',
        inputR2Keys: ['generations/gen-postprocess-1.mp4'],
        audioR2Key: 'assets/trend-audio/love-island.m4a',
        mediaType: 'video',
      });
      expect(markCompleted).not.toHaveBeenCalled();
      expect(sendGenerationComplete).not.toHaveBeenCalled();
    });

    it('marks completed as usual when params.postprocess is absent (regression guard)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-1',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 45,
        params: {},
      });

      const res = await post({ id: 'pred_123', status: 'succeeded', output: ['https://replicate.delivery/abc.mp4'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(markCompleted).toHaveBeenCalledWith('gen-1', 'generations/gen-1.mp4');
      expect(mockFfmpegQueueAdd).not.toHaveBeenCalled();
    });

    it('falls back to markCompleted and does NOT enqueue when audio_r2_key is not an internal assets/ key (T-09.3-10)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-postprocess-2',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 27,
        media_type: 'video',
        params: { postprocess: { op: 'mux', audio_r2_key: 'https://evil.example.com/steal.m4a' } },
      });
      (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-postprocess-2.mp4');

      const res = await post({ id: 'pred_postprocess_2', status: 'succeeded', output: ['https://replicate.delivery/clip.mp4'] });

      expect(res.status).toBe(200);
      expect(mockFfmpegQueueAdd).not.toHaveBeenCalled();
      expect(markCompleted).toHaveBeenCalledWith('gen-postprocess-2', 'generations/gen-postprocess-2.mp4');
    });
  });

  describe('transient-failure auto-retry', () => {
    const retryableGeneration = {
      id: 'gen-retry-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 27,
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      prompt: 'animate this',
      params: { duration: 6, resolution: '720p', aspect_ratio: '9:16', audio_enabled: true, ref_upload_ids: [] },
      retry_count: 0,
    };

    it('redispatches once on a transient ReadError and does not refund or mark failed', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue(retryableGeneration);

      const res = await post({ id: 'pred_transient_1', status: 'failed', error: 'Prediction failed: Async prediction failed: ReadError:' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, retried: true });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0][0]).toMatchObject({ model: 'bytedance/seedance-2.0-mini', prompt: 'animate this' });
      expect(reattachForRetry).toHaveBeenCalledWith('gen-retry-1', 'pred_retry_1');
      expect(markFailed).not.toHaveBeenCalled();
      expect(refundCredits).not.toHaveBeenCalled();
    });

    it('marks failed as provider_error and refunds exactly once when retry_count is already 1', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({ ...retryableGeneration, retry_count: 1 });

      const res = await post({ id: 'pred_transient_2', status: 'failed', error: 'Prediction failed: Async prediction failed: ReadError:' });

      expect(res.status).toBe(200);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledTimes(1);
      expect(markFailed).toHaveBeenCalledWith('gen-retry-1', 'provider_error');
      expect(refundCredits).toHaveBeenCalledTimes(1);
      expect(refundCredits).toHaveBeenCalledWith('u1', 27, 'pred_transient_2');
    });

    it('does not retry a copyright failure even on a retryable model', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue(retryableGeneration);

      const res = await post({
        id: 'pred_copyright_1',
        status: 'failed',
        error: 'The request failed because the output video may be related to copyright restrictions.',
      });

      expect(res.status).toBe(200);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith('gen-retry-1', 'copyright');
      expect(refundCredits).toHaveBeenCalledWith('u1', 27, 'pred_copyright_1');
    });
  });

  describe('content-policy Grok fallback (09.3 SC2)', () => {
    // D-02: Seedance content_policy block (E005 "flagged as sensitive") on an auto-picked model
    // (no explicit user model choice) falls back to Grok 1.5 (the permissive real-face/IP i2v
    // catch-all) instead of immediately failing+refunding. RED until 09.3-03 adds this sibling
    // branch to the transient-retry block in webhooks/replicate.ts — today ANY non-transient
    // failure (content_policy included) always hits markFailed+refundCredits with no fallback
    // attempt, and there is no `model_explicitly_picked` signal read anywhere in this file yet.
    const autoModelGeneration = {
      id: 'gen-fallback-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 27,
      media_type: 'video',
      model: 'bytedance/seedance-2.0-mini',
      prompt: 'a fictional gorilla vlogs about its day',
      params: {
        duration: 6,
        resolution: '720p',
        aspect_ratio: '9:16',
        audio_enabled: true,
        ref_upload_ids: [],
        // Gap flagged in PATTERNS.md — no existing analog for this flag; grep clean today.
        model_explicitly_picked: false,
      },
      retry_count: 0,
    };

    it('redispatches to Grok 1.5 on a content_policy failure when the model was auto-picked, and does NOT refund (RED until 09.3-03)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue(autoModelGeneration);
      dispatchMock.mockResolvedValue({ providerPredictionId: 'pred_grok_fallback_1' });

      const res = await post({
        id: 'pred_content_policy_1',
        status: 'failed',
        error: 'ModelError: The input or output was flagged as sensitive ... (E005)',
      });

      expect(res.status).toBe(200);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0][0]).toMatchObject({ model: 'xai/grok-imagine-video-1.5' });
      expect(reattachForRetry).toHaveBeenCalledWith('gen-fallback-1', 'pred_grok_fallback_1');
      expect(markFailed).not.toHaveBeenCalled();
      expect(refundCredits).not.toHaveBeenCalled();
    });

    it('does NOT fall back to Grok when the user explicitly picked the model — normal fail+refund path (regression guard)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        ...autoModelGeneration,
        id: 'gen-fallback-2',
        params: { ...autoModelGeneration.params, model_explicitly_picked: true },
      });

      const res = await post({
        id: 'pred_content_policy_2',
        status: 'failed',
        error: 'ModelError: The input or output was flagged as sensitive ... (E005)',
      });

      expect(res.status).toBe(200);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith('gen-fallback-2', 'content_policy');
      expect(refundCredits).toHaveBeenCalledWith('u1', 27, 'pred_content_policy_2');
    });

    it('transient ReadError still redispatches same-model (never Grok) — regression guard for the existing retry path', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue(autoModelGeneration);
      dispatchMock.mockResolvedValue({ providerPredictionId: 'pred_transient_same_model' });

      const res = await post({
        id: 'pred_transient_fallback_check',
        status: 'failed',
        error: 'Prediction failed: Async prediction failed: ReadError:',
      });

      expect(res.status).toBe(200);
      expect(dispatchMock.mock.calls[0][0]).toMatchObject({ model: 'bytedance/seedance-2.0-mini' });
      expect(reattachForRetry).toHaveBeenCalledWith('gen-fallback-1', 'pred_transient_same_model');
    });
  });

  describe('SC1 — post-archive raw face upload deletion', () => {
    it('deletes the R2 object and reference_uploads row for a succeeded faceswap generation', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-face-1',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 20,
        media_type: 'faceswap',
        params: { preset_id: 'faceswap', preset_input_upload_ids: ['upload-1'] },
      });
      dbMock.select.mockReturnValue(
        makeSelectChain([{ id: 'upload-1', r2_key: 'uploads/u1/face.jpg' }]),
      );

      const res = await post({ id: 'pred_face_1', status: 'succeeded', output: ['https://replicate.delivery/face-out.mp4'] });

      expect(res.status).toBe(200);
      expect(markCompleted).toHaveBeenCalledWith('gen-face-1', 'generations/gen-1.mp4');
      const deleteCall = (r2Mock.send as jest.Mock).mock.calls.find(
        (c) => c[0] instanceof (require('@aws-sdk/client-s3').DeleteObjectCommand),
      );
      expect(deleteCall?.[0].input).toEqual({ Bucket: 'test-bucket', Key: 'uploads/u1/face.jpg' });
      expect(dbMock.delete).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a succeeded non-face-input preset (no reference_uploads deleted)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-hairstyle-1',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 10,
        media_type: 'image',
        params: { preset_id: 'hairstyle', preset_input_upload_ids: ['upload-2'] },
      });
      (archiveToR2 as jest.Mock).mockResolvedValue('generations/gen-hairstyle-1.jpg');

      const res = await post({ id: 'pred_hairstyle_1', status: 'succeeded', output: ['https://replicate.delivery/hairstyle-out.jpg'] });

      expect(res.status).toBe(200);
      expect(markCompleted).toHaveBeenCalledWith('gen-hairstyle-1', 'generations/gen-hairstyle-1.jpg');
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(dbMock.delete).not.toHaveBeenCalled();
      expect(r2Mock.send).not.toHaveBeenCalled();
    });

    it('still returns 200 when the deletion throws (best-effort, never breaks the webhook)', async () => {
      (validateWebhook as jest.Mock).mockResolvedValue(true);
      (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
        id: 'gen-face-2',
        user_id: 'u1',
        status: 'processing',
        cost_credits: 20,
        media_type: 'faceswap',
        params: { preset_id: 'faceswap', preset_input_upload_ids: ['upload-3'] },
      });
      dbMock.select.mockReturnValue(
        makeSelectChain([{ id: 'upload-3', r2_key: 'uploads/u1/face3.jpg' }]),
      );
      r2Mock.send.mockRejectedValue(new Error('R2 down'));

      const res = await post({ id: 'pred_face_2', status: 'succeeded', output: ['https://replicate.delivery/face-out2.mp4'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(markCompleted).toHaveBeenCalledWith('gen-face-2', 'generations/gen-1.mp4');
      // deletion failed before the DB delete — row must not be deleted on a failed R2 delete
      expect(dbMock.delete).not.toHaveBeenCalled();
    });
  });
});
