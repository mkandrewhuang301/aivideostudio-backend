jest.mock('../../config', () => ({ config: {} }));

const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: { execute: mockExecute },
}));

const mockGetUserWithBalance = jest.fn();
jest.mock('../../services/creditService', () => ({
  getUserWithBalance: mockGetUserWithBalance,
}));

const mockDeleteUserAccount = jest.fn();
jest.mock('../../services/accountDeletionService', () => ({
  deleteUserAccount: mockDeleteUserAccount,
}));

const mockGrantIfEligible = jest.fn();
jest.mock('../../services/freeCreditGrantService', () => ({
  grantIfEligible: mockGrantIfEligible,
}));

const mockMergeUser = jest.fn();
jest.mock('../../services/userMergeService', () => ({
  mergeUser: mockMergeUser,
  MergeError: class MergeError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
}));

const mockVerifyIdToken = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { verifyIdToken: mockVerifyIdToken } }),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { meRouter } from '../../routes/me';
import { MergeError } from '../../services/userMergeService';

function buildApp(user: { uid: string; email?: string; dbUserId: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/me', meRouter);
  return app;
}

const TARGET_USER = {
  uid: 'existing-firebase-uid',
  email: 'existing@example.com',
  dbUserId: 'existing-db-user-id',
};

const SOURCE_UID = 'anonymous-firebase-uid';
const SOURCE_DB_ID = 'anonymous-db-user-id';
const SOURCE_TOKEN = 'anonymous-id-token';

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({
    uid: SOURCE_UID,
    firebase: { sign_in_provider: 'anonymous' },
  });
  mockExecute.mockResolvedValue({ rows: [{ id: SOURCE_DB_ID }] });
  mockMergeUser.mockResolvedValue(undefined);
});

describe('POST /api/me/merge', () => {
  it('returns 204 on valid merge', async () => {
    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(204);
  });

  it('passes the verified source identity and authenticated target to mergeUser', async () => {
    await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(mockVerifyIdToken).toHaveBeenCalledWith(SOURCE_TOKEN);
    expect(mockMergeUser).toHaveBeenCalledWith(SOURCE_DB_ID, TARGET_USER.dbUserId, SOURCE_UID);
  });

  it('returns 409 when the source account was already merged', async () => {
    mockMergeUser.mockRejectedValueOnce(new MergeError('ALREADY_MERGED'));

    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ALREADY_MERGED');
  });
});

describe('auth', () => {
  it('returns 401 when the target request is unauthenticated', async () => {
    const response = await request(buildApp(null))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the anonymous Firebase token is invalid', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('invalid token'));

    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_ANONYMOUS_TOKEN');
    expect(mockMergeUser).not.toHaveBeenCalled();
  });

  it('rejects a source token that is not for an anonymous Firebase user', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: SOURCE_UID,
      firebase: { sign_in_provider: 'password' },
    });

    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('ANONYMOUS_PROVIDER_REQUIRED');
  });
});

describe('validation', () => {
  it('returns 400 when anonymousUid is missing', async () => {
    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('MISSING_ANONYMOUS_UID');
  });

  it('returns 400 when anonymousToken is missing', async () => {
    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('MISSING_ANONYMOUS_TOKEN');
  });

  it('rejects a token whose uid differs from anonymousUid', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: 'different-anonymous-uid',
      firebase: { sign_in_provider: 'anonymous' },
    });

    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('ANONYMOUS_UID_MISMATCH');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 404 when the anonymous database user does not exist', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const response = await request(buildApp(TARGET_USER))
      .post('/api/me/merge')
      .send({ anonymousUid: SOURCE_UID, anonymousToken: SOURCE_TOKEN });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ANONYMOUS_USER_NOT_FOUND');
  });
});
