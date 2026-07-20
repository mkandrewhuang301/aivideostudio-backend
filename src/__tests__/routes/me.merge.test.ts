// Wave 0 scaffold for POST /api/me/merge.
// Plan 18-03 replaces these TODOs with request/response assertions.

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

const mockMergeUser = jest.fn();
jest.mock('../../services/userMergeService', () => ({
  mergeUser: mockMergeUser,
}), { virtual: true });

const mockVerifyIdToken = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { verifyIdToken: mockVerifyIdToken } }),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { meRouter } from '../../routes/me';

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

void request;
void buildApp;
void TARGET_USER;

describe('POST /api/me/merge', () => {
  it.todo('returns 204 on valid merge');
  it.todo('passes the source identity and target account to mergeUser');
  it.todo('returns 409 when the source account was already merged');
});

describe('auth', () => {
  it.todo('returns 401 when the target request is unauthenticated');
  it.todo('returns 401 when the anonymous Firebase token is invalid');
  it.todo('rejects a source token that is not for an anonymous Firebase user');
});

describe('validation', () => {
  it.todo('returns 400 when anonymousUid is missing');
  it.todo('returns 400 when anonymousToken is missing');
  it.todo('rejects a token whose uid differs from anonymousUid');
});
