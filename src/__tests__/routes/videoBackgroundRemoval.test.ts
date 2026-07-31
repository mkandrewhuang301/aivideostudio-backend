// Focused contract coverage for the Apple Vision upload route. The service layer and R2 client
// are mocked so this verifies Express routing + multipart parsing without external dependencies.

jest.mock('../../config', () => ({ config: { videoBgRemovalEnabled: true } }));

jest.mock('../../queue/videoBackgroundRemovalQueue', () => ({
  videoBackgroundRemovalQueue: { add: jest.fn() },
}));

jest.mock('../../services/providers/VideoBackgroundRemovalProvider', () => ({
  BACKGROUND_COLORS: ['Transparent'],
}));

jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn() },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(({ params }) => ({
    // Consume the route's read stream before resolving, matching the real uploader. Resolving
    // immediately lets the route unlink its multer temp file before the stream has opened.
    done: jest.fn().mockImplementation(async () => {
      await new Promise<void>((resolve, reject) => {
        params.Body.on('error', reject);
        params.Body.on('end', resolve);
        params.Body.resume();
      });
    }),
  })),
}));

jest.mock('../../services/videoBackgroundRemovalService', () => ({
  BgRemovalInProgressError: class BgRemovalInProgressError extends Error {},
  BgRemovalRateLimitedError: class BgRemovalRateLimitedError extends Error {},
  InsufficientBgRemovalCreditsError: class InsufficientBgRemovalCreditsError extends Error {},
  VideoBgRemovalNotFoundError: class VideoBgRemovalNotFoundError extends Error {},
  VideoBgRemovalValidationError: class VideoBgRemovalValidationError extends Error {},
  applyOnDeviceBackgroundRemoval: jest.fn(),
  checkDailyRateLimit: jest.fn(),
  createVideoBackgroundRemovalJob: jest.fn(),
  findVideoBackgroundRemovalByIdempotency: jest.fn(),
  getBgRemovalJob: jest.fn(),
  parseBackgroundColor: jest.fn(),
  quoteVideoBackgroundRemoval: jest.fn(),
  redoBackgroundRemoval: jest.fn(),
  refundBgRemoval: jest.fn(),
  undoBackgroundRemoval: jest.fn(),
}));

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { videoBackgroundRemovalRouter } from '../../routes/videoBackgroundRemoval';
import {
  applyOnDeviceBackgroundRemoval,
  findVideoBackgroundRemovalByIdempotency,
  getBgRemovalJob,
  quoteVideoBackgroundRemoval,
  redoBackgroundRemoval,
} from '../../services/videoBackgroundRemovalService';

const CLIP_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'db-user-1';

function buildApp() {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { uid: 'firebase-user-1', dbUserId: USER_ID } as never;
    next();
  });
  app.use('/api', videoBackgroundRemovalRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /clips/:clipId/background-removals/on-device', () => {
  it('accepts the iOS QuickTime multipart contract and returns the decodable 201 payload', async () => {
    (findVideoBackgroundRemovalByIdempotency as jest.Mock).mockResolvedValue(null);
    (quoteVideoBackgroundRemoval as jest.Mock).mockResolvedValue({
      supported: true,
      duration_seconds: 3,
      cost_credits: 2,
    });
    (applyOnDeviceBackgroundRemoval as jest.Mock).mockResolvedValue({
      created: true,
      row: {
        id: JOB_ID,
        status: 'completed',
        cost_credits: 0,
        output_r2_key: 'video-background-removal/user/result.mov',
        source_prior_r2_key: 'clips/user/original.mov',
      },
    });

    const response = await request(buildApp())
      .post(`/api/clips/${CLIP_ID}/background-removals/on-device`)
      .set('Idempotency-Key', 'on-device-key-1')
      .attach('file', Buffer.from('quicktime-test-payload'), {
        filename: 'background-removed.mov',
        contentType: 'video/quicktime',
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      job_id: JOB_ID,
      status: 'completed',
      cost_credits: 0,
      applied: true,
      can_undo: true,
    });
    expect(applyOnDeviceBackgroundRemoval).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      clipId: CLIP_ID,
      idempotencyKey: 'on-device-key-1',
      outputR2Key: expect.stringMatching(/^video-background-removal\/.+\.mov$/),
    }));
  });
});

describe('POST /clips/:clipId/background-removals/:jobId/redo', () => {
  it('re-applies the retained output for the owned clip job', async () => {
    (getBgRemovalJob as jest.Mock).mockResolvedValue({
      id: JOB_ID,
      user_id: USER_ID,
      source_clip_id: CLIP_ID,
    });
    (redoBackgroundRemoval as jest.Mock).mockResolvedValue({ restoredR2Key: 'processed.mov' });

    const response = await request(buildApp())
      .post(`/api/clips/${CLIP_ID}/background-removals/${JOB_ID}/redo`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'redone' });
    expect(redoBackgroundRemoval).toHaveBeenCalledWith(JOB_ID, USER_ID);
  });
});
