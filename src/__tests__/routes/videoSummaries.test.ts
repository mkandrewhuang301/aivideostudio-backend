jest.mock('../../config', () => ({
  config: { videoSummaryModel: 'gemini-test', openaiApiKey: 'test' },
}));
jest.mock('../../config/formats', () => ({
  FORMATS_BY_ID: {
    explainer: {
      voice_default: 'Kore',
      voices: [{ id: 'Kore', label: 'Kore' }],
    },
  },
  VIDEO_SUMMARY_FORMAT: {
    voice_default: 'Kore',
    voices: [
      { id: 'Kore', label: 'Kore' },
      { id: 'Charon', label: 'Charon' },
    ],
  },
}));
jest.mock('../../db/client', () => ({
  db: { select: jest.fn(), insert: jest.fn() },
}));
const uploadDone = jest.fn();
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: uploadDone })),
}));
const mockR2Send = jest.fn();
jest.mock('../../storage/r2', () => ({ r2: { send: mockR2Send }, R2_BUCKET: 'test-bucket' }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/direct-put'),
}));
jest.mock('../../middleware/concurrencyGate', () => ({
  concurrencyGate: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../middleware/promptModeration', () => ({
  promptModerationMiddleware: jest.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  isPromptFlagged: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../services/archivalService', () => ({ getUploadPresignedUrl: jest.fn() }));
jest.mock('../../services/mediaProbe', () => ({ probeDurationSeconds: jest.fn() }));
jest.mock('../../services/hiveService', () => ({ scanInputMedia: jest.fn() }));
jest.mock('../../services/creditService', () => ({
  deductCredits: jest.fn(),
  refundCredits: jest.fn(),
}));
jest.mock('../../services/generationService', () => ({
  createGeneration: jest.fn(),
  markFailed: jest.fn(),
}));
jest.mock('../../queue/videoSummaryQueue', () => ({
  videoSummaryQueue: { add: jest.fn() },
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { db } from '../../db/client';
import { videoSummariesRouter } from '../../routes/videoSummaries';
import { getUploadPresignedUrl } from '../../services/archivalService';
import { probeDurationSeconds } from '../../services/mediaProbe';
import { scanInputMedia } from '../../services/hiveService';
import { deductCredits, refundCredits } from '../../services/creditService';
import { createGeneration, markFailed } from '../../services/generationService';
import { videoSummaryQueue } from '../../queue/videoSummaryQueue';
import { isPromptFlagged } from '../../middleware/promptModeration';

const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'user-1', uid: 'firebase-1', email: 'test@example.com' };
  next();
});
app.use('/api/video-summaries', videoSummariesRouter);

function mockOwnedUpload(): void {
  (db.select as jest.Mock).mockReturnValue({
    from: jest.fn(() => ({
      where: jest.fn().mockResolvedValue([{ r2Key: 'uploads/user-1/episode.mp4', mimeType: 'video/mp4' }]),
    })),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnedUpload();
  (getUploadPresignedUrl as jest.Mock).mockResolvedValue('https://r2.example.com/episode.mp4');
  (probeDurationSeconds as jest.Mock).mockResolvedValue(24 * 60);
  (scanInputMedia as jest.Mock).mockResolvedValue({ blocked: false });
  (deductCredits as jest.Mock).mockResolvedValue(true);
  (refundCredits as jest.Mock).mockResolvedValue(undefined);
  (createGeneration as jest.Mock).mockResolvedValue({ id: 'gen-summary-1' });
  (markFailed as jest.Mock).mockResolvedValue(true);
  (videoSummaryQueue.add as jest.Mock).mockResolvedValue(undefined);
  uploadDone.mockResolvedValue(undefined);
  mockR2Send.mockResolvedValue({ ContentLength: 1234 });
  (db.insert as jest.Mock).mockReturnValue({
    values: jest.fn(() => ({
      returning: jest.fn().mockResolvedValue([{ id: UPLOAD_ID }]),
    })),
  });
});

describe('POST /api/video-summaries', () => {
  it('authorizes a private direct-to-R2 upload without proxying episode bytes through the service', async () => {
    const response = await request(app).post('/api/video-summaries/upload-intent').send({
      file_name: 'episode.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1234,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: UPLOAD_ID,
      upload_url: 'https://r2.example.com/direct-put',
      mime_type: 'video/mp4',
      required_headers: { 'Content-Type': 'video/mp4' },
    });
    expect(db.insert).toHaveBeenCalled();
    expect(uploadDone).not.toHaveBeenCalled();
  });

  it('streams a full-size source through the dedicated upload route and hides it as summary_source', async () => {
    const response = await request(app)
      .post('/api/video-summaries/upload')
      .attach('file', Buffer.from('video bytes'), { filename: 'episode.mp4', contentType: 'video/mp4' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: UPLOAD_ID, mime_type: 'video/mp4' });
    expect(uploadDone).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalled();
  });

  it('normalizes the retired focused mode into a full summary with optional context', async () => {
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'theme',
      prompt: 'John gets saved',
      output_duration_seconds: 60,
      aspect_ratio: '9:16',
      voice_id: 'Kore',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      generation_id: 'gen-summary-1',
      status: 'processing',
      cost_credits: 88,
      source_duration_seconds: 1440,
    });
    expect(scanInputMedia).toHaveBeenCalledWith('https://r2.example.com/episode.mp4');
    expect(deductCredits).toHaveBeenCalledWith('user-1', 88);
    expect(createGeneration).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      media_type: 'video',
      cost_credits: 88,
      prompt: 'John gets saved',
      params: expect.objectContaining({
        format_id: 'video-explainer',
        summary_mode: 'episode',
        user_context_supplied: true,
      }),
    }));
    expect(videoSummaryQueue.add).toHaveBeenCalledWith('generate', expect.objectContaining({
      generationId: 'gen-summary-1',
      sourceR2Key: 'uploads/user-1/episode.mp4',
      mode: 'episode',
      theme: null,
      context: 'John gets saved',
    }));
  });

  it('allows an empty optional context and still creates a full summary', async () => {
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'theme',
      output_duration_seconds: 60,
      include_music: false,
    });
    expect(response.status).toBe(200);
    expect(response.body.cost_credits).toBe(84);
    expect(deductCredits).toHaveBeenCalledWith('user-1', 84);
    expect(videoSummaryQueue.add).toHaveBeenCalledWith('generate', expect.objectContaining({
      mode: 'episode',
      context: null,
      includeMusic: false,
      aspectRatio: '9:16',
    }));
  });

  it('moderates the new context field before charging', async () => {
    (isPromptFlagged as jest.Mock).mockResolvedValueOnce(true);
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      context: 'unsafe context',
      output_duration_seconds: 60,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('content_policy_violation');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('rejects oversized context before analysis or charging', async () => {
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      context: 'x'.repeat(601),
      output_duration_seconds: 60,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CONTEXT');
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('blocks a source video that fails the input NSFW scan before any charge', async () => {
    (scanInputMedia as jest.Mock).mockResolvedValueOnce({ blocked: true, reason: 'nsfw' });
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'episode',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INPUT_MEDIA_BLOCKED');
    expect(deductCredits).not.toHaveBeenCalled();
    expect(videoSummaryQueue.add).not.toHaveBeenCalled();
  });

  it('rejects with 402 when credits are insufficient and never dispatches', async () => {
    (deductCredits as jest.Mock).mockResolvedValueOnce(false);
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'episode',
    });
    expect(response.status).toBe(402);
    expect(response.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(videoSummaryQueue.add).not.toHaveBeenCalled();
  });

  it('refunds using a stable idempotency key and returns 500 when generation creation throws', async () => {
    (createGeneration as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'episode',
    });
    expect(response.status).toBe(500);
    expect(refundCredits).toHaveBeenCalledWith('user-1', 88, `video-summary-create-user-1-${UPLOAD_ID}`);
    expect(videoSummaryQueue.add).not.toHaveBeenCalled();
  });

  it('never charges for an upload the authenticated user does not own', async () => {
    (db.select as jest.Mock).mockReturnValueOnce({
      from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
    });
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'episode',
    });
    expect(response.status).toBe(404);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('marks failed and refunds the exact charge if queue dispatch fails', async () => {
    (videoSummaryQueue.add as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
    const response = await request(app).post('/api/video-summaries').send({
      upload_id: UPLOAD_ID,
      mode: 'episode',
    });
    expect(response.status).toBe(502);
    expect(markFailed).toHaveBeenCalledWith('gen-summary-1', 'generic_error');
    expect(refundCredits).toHaveBeenCalledWith('user-1', 88, 'video-summary-dispatch-gen-summary-1');
  });
});
