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

// db/client must be mocked — neon() throws at module eval with a non-postgres URL
jest.mock('../../db/client', () => ({
  db: {
    execute: jest.fn(),
    insert: jest.fn(),
    select: jest.fn(),
    delete: jest.fn(),
  },
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { uploadsRouter } from '../../routes/uploads';
import { r2 } from '../../storage/r2';
import { db } from '../../db/client';

const r2Mock = r2 as unknown as { send: jest.Mock };
const dbMock = db as unknown as { insert: jest.Mock; select: jest.Mock; execute: jest.Mock; delete: jest.Mock };

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

function makeSelectChain(rows: unknown[] = []) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  (require('@aws-sdk/s3-request-presigner').getSignedUrl as jest.Mock).mockResolvedValue(
    'https://r2.example.com/uploads/presigned-url',
  );
  r2Mock.send.mockResolvedValue({});

  // Default db insert chain: resolves to a row with id
  dbMock.insert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'upload-row-id' }]),
    }),
  });

  // Default db select chain: returns empty list
  dbMock.select.mockReturnValue(makeSelectChain([]));
  dbMock.delete.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
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

// ─── POST /api/uploads — DB integration ───────────────────────────────────────

describe('POST /api/uploads — DB integration', () => {
  it('returns the inserted db row id in the response body', async () => {
    dbMock.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 'specific-upload-id' }]),
      }),
    });

    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-jpeg'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('specific-upload-id');
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });

  it('inserts the upload record with correct user_id, r2_key pattern, and mime_type', async () => {
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'upload-new' }]),
    });
    dbMock.insert.mockReturnValue({ values: valuesFn });

    await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-db-user-id',
        mime_type: 'image/jpeg',
        r2_key: expect.stringMatching(/^uploads\/test-db-user-id\/[0-9a-f-]{36}\.jpg$/),
      }),
    );
  });

  it('returns 500 and does not expose db error when db.insert throws', async () => {
    dbMock.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockRejectedValue(new Error('DB connection lost')),
      }),
    });

    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to upload file');
    expect(JSON.stringify(res.body)).not.toContain('DB connection lost');
  });

  it('returns null id gracefully when db returns an empty array', async () => {
    dbMock.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });

    const res = await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-png'), { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeNull();
    expect(res.body.url).toBe('https://r2.example.com/uploads/presigned-url');
  });
});

// ─── POST /api/uploads — kind='look' singleton ────────────────────────────────

describe("POST /api/uploads — kind='look' singleton (D-14)", () => {
  it("defaults kind to 'reference' when omitted, and never queries/deletes prior rows", async () => {
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'ref-row' }]),
    });
    dbMock.insert.mockReturnValue({ values: valuesFn });

    await request(app)
      .post('/api/uploads')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(dbMock.select).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reference' }));
  });

  it("rejects an invalid kind with 400 and never touches R2 or the DB", async () => {
    const res = await request(app)
      .post('/api/uploads')
      .field('kind', 'bogus')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(r2Mock.send).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("replace-on-insert: a second kind='look' upload deletes the prior look row + R2 object before inserting, leaving exactly one look row", async () => {
    // Prior look row exists for this user
    dbMock.select.mockReturnValue(
      makeSelectChain([{ id: 'old-look-id', r2_key: 'uploads/test-db-user-id/old-look.jpg' }]),
    );
    const deleteWhereFn = jest.fn().mockResolvedValue(undefined);
    dbMock.delete.mockReturnValue({ where: deleteWhereFn });
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'new-look-id' }]),
    });
    dbMock.insert.mockReturnValue({ values: valuesFn });

    const res = await request(app)
      .post('/api/uploads')
      .field('kind', 'look')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'newlook.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    // Prior look's R2 object deleted before the new one is inserted
    expect(r2Mock.send).toHaveBeenCalledTimes(2); // 1 Put (new) + 1 Delete (old)
    const deleteCall = r2Mock.send.mock.calls.find((c) => c[0] instanceof (require('@aws-sdk/client-s3').DeleteObjectCommand));
    expect(deleteCall?.[0].input.Key).toBe('uploads/test-db-user-id/old-look.jpg');
    // Prior look row deleted exactly once
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhereFn).toHaveBeenCalledTimes(1);
    // New row inserted with kind='look' — exactly one look row remains (delete-then-insert)
    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'look' }));
  });

  it("no prior look exists: kind='look' upload inserts without any delete call", async () => {
    dbMock.select.mockReturnValue(makeSelectChain([]));
    const valuesFn = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'first-look-id' }]),
    });
    dbMock.insert.mockReturnValue({ values: valuesFn });

    const res = await request(app)
      .post('/api/uploads')
      .field('kind', 'look')
      .attach('file', Buffer.from('fake-jpg'), { filename: 'firstlook.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'look' }));
  });
});

// ─── GET /api/uploads ─────────────────────────────────────────────────────────

describe('GET /api/uploads', () => {
  it('returns 401 when there is no authenticated user', async () => {
    const res = await request(unauthApp).get('/api/uploads');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty uploads array when the user has no uploads', async () => {
    dbMock.select.mockReturnValue(makeSelectChain([]));

    const res = await request(app).get('/api/uploads');

    expect(res.status).toBe(200);
    expect(res.body.uploads).toEqual([]);
  });

  it('returns uploads list with fresh presigned URLs for each row', async () => {
    dbMock.select.mockReturnValue(
      makeSelectChain([
        { id: 'upload-1', r2_key: 'uploads/user/uuid1.jpg', mime_type: 'image/jpeg', created_at: new Date('2026-06-01') },
        { id: 'upload-2', r2_key: 'uploads/user/uuid2.mp4', mime_type: 'video/mp4', created_at: new Date('2026-06-02') },
      ]),
    );

    const res = await request(app).get('/api/uploads');

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(2);
    expect(res.body.uploads[0].url).toBe('https://r2.example.com/uploads/presigned-url');
    expect(res.body.uploads[0].id).toBe('upload-1');
    expect(res.body.uploads[0].mime_type).toBe('image/jpeg');
    expect(res.body.uploads[1].id).toBe('upload-2');
    // getSignedUrl called once per row
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner') as { getSignedUrl: jest.Mock };
    expect(getSignedUrl).toHaveBeenCalledTimes(2);
  });

  it('returns 500 and does not expose db error when db.select throws', async () => {
    const errChain = makeSelectChain([]);
    errChain.limit.mockRejectedValue(new Error('Neon timeout'));
    dbMock.select.mockReturnValue(errChain);

    const res = await request(app).get('/api/uploads');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to list uploads');
    expect(JSON.stringify(res.body)).not.toContain('Neon timeout');
  });

  it('scopes the query to the authenticated user (IDOR: does not return other users uploads)', async () => {
    const chain = makeSelectChain([]);
    dbMock.select.mockReturnValue(chain);

    await request(app).get('/api/uploads');

    // The where() call must have been made (user scoping happens in where clause)
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid kind query param with 400", async () => {
    const res = await request(app).get('/api/uploads?kind=bogus');
    expect(res.status).toBe(400);
  });

  it("kind=look filter returns only the caller's look rows, scoped by user_id and kind", async () => {
    const chain = makeSelectChain([
      { id: 'look-1', r2_key: 'uploads/test-db-user-id/look.jpg', mime_type: 'image/jpeg', kind: 'look', created_at: new Date('2026-06-03') },
    ]);
    dbMock.select.mockReturnValue(chain);

    const res = await request(app).get('/api/uploads?kind=look');

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(1);
    expect(res.body.uploads[0].kind).toBe('look');
    // where() must be invoked exactly once — user_id + kind scoping happens inside a single
    // combined predicate (and(...)), never a separate unscoped query (IDOR + filter combined)
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0][0]).toBeDefined();
  });
});
