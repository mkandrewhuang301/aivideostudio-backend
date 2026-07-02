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
    hiveScanEnabled: true,
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

jest.mock('replicate', () => ({
  validateWebhook: jest.fn(),
}));

const mockHiveScanQueueAdd = jest.fn();
jest.mock('../../../queue/hiveScanWorker', () => ({
  hiveScanQueue: { add: mockHiveScanQueueAdd },
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
}));

jest.mock('../../../services/hiveService', () => ({
  scanForCsam: jest.fn(),
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
}));

jest.mock('../../../db/client', () => ({
  db: {
    execute: jest.fn(),
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) })),
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
import { replicateWebhookRouter } from '../../../routes/webhooks/replicate';

const MockedReplicateProvider = ReplicateProvider as jest.MockedClass<typeof ReplicateProvider>;
const providerInstance = MockedReplicateProvider.mock.results[0]?.value as { dispatch: jest.Mock };
const dispatchMock = providerInstance.dispatch;

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

  it('quarantines and refunds when Hive flags the video — never marks completed or sends push', async () => {
    (validateWebhook as jest.Mock).mockResolvedValue(true);
    (getGenerationByPredictionId as jest.Mock).mockResolvedValue({
      id: 'gen-1',
      user_id: 'u1',
      status: 'processing',
      cost_credits: 45,
    });
    (scanForCsam as jest.Mock).mockResolvedValue({ flagged: true });

    const res = await post({ id: 'pred_csam', status: 'succeeded', output: ['https://replicate.delivery/flagged.mp4'] });

    expect(res.status).toBe(200);
    expect(markQuarantined).toHaveBeenCalledWith('gen-1');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'csam-quarantine-pred_csam');
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
    });
    (scanForCsam as jest.Mock).mockRejectedValue(new Error('Hive timeout'));

    const res = await post({ id: 'pred_err', status: 'succeeded', output: ['https://replicate.delivery/video.mp4'] });

    expect(res.status).toBe(200);
    expect(mockHiveScanQueueAdd).toHaveBeenCalledWith('scan', {
      generationId: 'gen-1',
      r2Key: 'generations/gen-1.mp4',
      userId: 'u1',
      costCredits: 45,
    });
    expect(markQuarantined).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
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
});
