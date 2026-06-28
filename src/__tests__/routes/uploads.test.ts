// src/__tests__/routes/uploads.test.ts
// Integration tests for POST /api/uploads.
// Covers MIME whitelist acceptance/rejection, R2 key path format, presigned URL response.

// Mock config FIRST — config.ts calls requireEnv() at module eval time
jest.mock('../../config', () => ({
  config: {
    revenueCatWebhookSecret: 'test-webhook-secret',
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

jest.mock('../../storage/r2', () => ({
  r2: { send: jest.fn().mockResolvedValue({}) },
  R2_BUCKET: 'test-bucket',
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/uploads/presigned-url'),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { uploadsRouter } from '../../routes/uploads';
import { r2 } from '../../storage/r2';

const r2Mock = r2 as unknown as { send: jest.Mock };

const app = express();

// Inject authenticated user (mirrors authMiddleware behavior)
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.user = { dbUserId: 'test-db-user-id', uid: 'fb-uid', email: 't@test.com' };
  next();
});

app.use('/api/uploads', uploadsRouter);

// App without auth for 401 tests
const unauthApp = express();
unauthApp.use('/api/uploads', uploadsRouter);

beforeEach(() => {
  jest.clearAllMocks();
  (require('@aws-sdk/s3-request-presigner').getSignedUrl as jest.Mock).mockResolvedValue(
    'https://r2.example.com/uploads/presigned-url',
  );
  r2Mock.send.mockResolvedValue({});
});

describe('POST /api/uploads', () => {
  it('accepts image/jpeg and returns presigned URL', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-jpeg-data'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });

  it('accepts image/png and returns presigned URL', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-png-data'), { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });

  it('accepts image/webp and returns presigned URL', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-webp-data'), { filename: 'test.webp', contentType: 'image/webp' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });

  it('accepts video/mp4 and returns presigned URL', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-mp4-data'), { filename: 'test.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });

  it('rejects image/gif with 400 (not in whitelist)', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-gif'), { filename: 'test.gif', contentType: 'image/gif' });

    expect(res.status).toBe(400);
    expect(r2Mock.send).not.toHaveBeenCalled();
  });

  it('rejects video/quicktime (.mov) with 400 (not in whitelist)', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-mov'), { filename: 'test.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(400);
    expect(r2Mock.send).not.toHaveBeenCalled();
  });

  it('rejects text/plain with 400 (not in whitelist)', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('text content'), { filename: 'test.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when no file attached', async () => {
    const res = await request(app).post('/api/uploads');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No file');
  });

  it('returns 401 when no auth (req.user missing)', async () => {
    const res = await request(unauthApp)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
  });

  it('stores file to R2 under uploads/{userId}/{uuid}.{ext} key pattern', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-png'), { filename: 'img.png', contentType: 'image/png' });

    expect(r2Mock.send).toHaveBeenCalledTimes(1);
    const putCommand = r2Mock.send.mock.calls[0][0];
    expect(putCommand.input.Key).toMatch(/^uploads\/test-db-user-id\/[0-9a-f-]{36}\.png$/);
    expect(putCommand.input.Bucket).toBe('test-bucket');
    expect(putCommand.input.ContentType).toBe('image/png');
  });
});
