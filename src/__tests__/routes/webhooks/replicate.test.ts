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
}));

jest.mock('replicate', () => ({
  validateWebhook: jest.fn(),
}));

jest.mock('../../../services/archivalService', () => ({
  archiveToR2: jest.fn(),
}));

jest.mock('../../../services/generationService', () => ({
  getGenerationByPredictionId: jest.fn(),
  markCompleted: jest.fn(),
  markFailed: jest.fn(),
  markQuarantined: jest.fn(),
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

jest.mock('../../../db/client', () => ({
  db: {
    execute: jest.fn(),
  },
}));

import express from 'express';
import request from 'supertest';
import { validateWebhook } from 'replicate';
import { archiveToR2 } from '../../../services/archivalService';
import { getGenerationByPredictionId, markCompleted, markFailed, markQuarantined } from '../../../services/generationService';
import { scanForCsam } from '../../../services/hiveService';
import { refundCredits } from '../../../services/creditService';
import { sendGenerationComplete } from '../../../services/apnsService';
import { db } from '../../../db/client';
import { replicateWebhookRouter } from '../../../routes/webhooks/replicate';

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
    expect(archiveToR2).toHaveBeenCalledWith('https://replicate.delivery/abc.mp4', 'gen-1');
    expect(markCompleted).toHaveBeenCalledWith('gen-1', 'generations/gen-1.mp4');

    const archiveOrder = (archiveToR2 as jest.Mock).mock.invocationCallOrder[0];
    const completeOrder = (markCompleted as jest.Mock).mock.invocationCallOrder[0];
    expect(archiveOrder).toBeLessThan(completeOrder);

    expect(sendGenerationComplete).toHaveBeenCalledWith('device-token-1', 'gen-1');
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
    expect(markFailed).toHaveBeenCalledWith('gen-2');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'pred_456');
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

  it('quarantines and refunds when Hive throws — fail-safe, never delivers unscanned content', async () => {
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
    expect(markQuarantined).toHaveBeenCalledWith('gen-1');
    expect(refundCredits).toHaveBeenCalledWith('u1', 45, 'csam-quarantine-pred_err');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(sendGenerationComplete).not.toHaveBeenCalled();
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
});
