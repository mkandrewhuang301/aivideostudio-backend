const verifyMock = jest.fn();
const archiveMock = jest.fn();
const scanMock = jest.fn();
const getGenerationMock = jest.fn();
const markCompletedMock = jest.fn();
const markFailedMock = jest.fn();
const markQuarantinedMock = jest.fn();
const refundMock = jest.fn();
const pushMock = jest.fn();

jest.mock('../../../services/falWebhookVerify', () => ({
  verifyFalWebhookSignature: verifyMock,
}));

jest.mock('../../../services/archivalService', () => ({
  archiveToR2: archiveMock,
}));

jest.mock('../../../services/hiveService', () => ({
  scanForCsam: scanMock,
}));

jest.mock('../../../services/generationService', () => ({
  getGenerationByPredictionId: getGenerationMock,
  markCompleted: markCompletedMock,
  markFailed: markFailedMock,
  markQuarantined: markQuarantinedMock,
}));

jest.mock('../../../services/creditService', () => ({
  refundCredits: refundMock,
}));

jest.mock('../../../services/apnsService', () => ({
  sendGenerationComplete: pushMock,
}));

jest.mock('../../../services/uploadCleanup', () => ({
  deleteRawFaceUploads: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../config', () => ({
  config: { hiveScanEnabled: true },
}));

jest.mock('../../../db/client', () => ({
  db: {
    execute: jest.fn().mockResolvedValue({ rows: [{ apns_device_token: null }] }),
  },
}));

import express from 'express';
import request from 'supertest';
import { falWebhookRouter } from '../../../routes/webhooks/fal';

const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use('/webhooks/fal', falWebhookRouter);

const generation = {
  id: 'gen-video-bg',
  user_id: 'user-1',
  status: 'processing',
  cost_credits: 9,
  media_type: 'video',
  model: 'pixelcut/video-background-removal',
  prompt: null,
  params: {},
  retry_count: 0,
};

function postWebhook(body: object) {
  return request(app)
    .post('/webhooks/fal')
    .set('Content-Type', 'application/json')
    .set('x-fal-webhook-request-id', 'req-video-bg')
    .set('x-fal-webhook-user-id', 'fal-user')
    .set('x-fal-webhook-timestamp', '1234')
    .set('x-fal-webhook-signature', 'sig')
    .send(JSON.stringify(body));
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyMock.mockResolvedValue(true);
  archiveMock.mockResolvedValue('generations/gen-video-bg.mov');
  scanMock.mockResolvedValue({ flagged: false });
  markCompletedMock.mockResolvedValue(true);
});

describe('POST /webhooks/fal', () => {
  it('resolves non-Kling endpoint IDs and archives transparent output as QuickTime before completion', async () => {
    getGenerationMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(generation);

    const res = await postWebhook({
      request_id: 'req-video-bg',
      status: 'OK',
      payload: { video: { url: 'https://fal.media/cutout.mov' } },
    });

    expect(res.status).toBe(200);
    expect(getGenerationMock).toHaveBeenNthCalledWith(
      1,
      'fal-ai/kling-video/v3/standard/image-to-video::req-video-bg',
    );
    expect(getGenerationMock).toHaveBeenNthCalledWith(
      2,
      'pixelcut/video-background-removal::req-video-bg',
    );
    expect(archiveMock).toHaveBeenCalledWith(
      'https://fal.media/cutout.mov',
      'gen-video-bg',
      'video/quicktime',
    );
    expect(scanMock).toHaveBeenCalledWith('generations/gen-video-bg.mov');
    expect(markCompletedMock).toHaveBeenCalledWith(
      'gen-video-bg',
      'generations/gen-video-bg.mov',
    );
    expect(archiveMock.mock.invocationCallOrder[0]).toBeLessThan(
      markCompletedMock.mock.invocationCallOrder[0],
    );
  });

  it('rejects an invalid signature before generation lookup or archival', async () => {
    verifyMock.mockResolvedValue(false);

    const res = await postWebhook({ request_id: 'req-video-bg', status: 'OK' });

    expect(res.status).toBe(401);
    expect(getGenerationMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it('quarantines and refunds a flagged transparent output without exposing completion', async () => {
    getGenerationMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(generation);
    scanMock.mockResolvedValue({ flagged: true });

    const res = await postWebhook({
      request_id: 'req-video-bg',
      status: 'OK',
      payload: { video: { url: 'https://fal.media/cutout.mov' } },
    });

    expect(res.status).toBe(200);
    expect(markQuarantinedMock).toHaveBeenCalledWith('gen-video-bg');
    expect(refundMock).toHaveBeenCalledWith('user-1', 9, 'csam-quarantine-req-video-bg');
    expect(markCompletedMock).not.toHaveBeenCalled();
  });
});
