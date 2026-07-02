// src/__tests__/middleware/auth.test.ts
// Perf: verifies authMiddleware's in-memory cache skips the DB upsert on repeat requests
// within TTL, and that banned is threaded through so banCheckMiddleware needs no DB call.

jest.mock('../../config', () => ({ config: {} }));

const mockVerifyIdToken = jest.fn();
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: () => ({ auth: { verifyIdToken: mockVerifyIdToken } }),
}));

const mockReturning = jest.fn();
const mockOnConflictDoUpdate = jest.fn(() => ({ returning: mockReturning }));
const mockValues = jest.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = jest.fn(() => ({ values: mockValues }));
jest.mock('../../db/client', () => ({
  db: { insert: mockInsert },
}));

import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth';

function buildReqRes(idToken = 'valid-token') {
  const req = { headers: { authorization: `Bearer ${idToken}` } } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('authMiddleware caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts on first request, then skips the DB call on a repeat request within TTL', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-1', email: 'a@test.com' });
    mockReturning.mockResolvedValue([{ id: 'db-user-1', banned: false }]);

    const first = buildReqRes();
    await authMiddleware(first.req, first.res, first.next);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(first.next).toHaveBeenCalledTimes(1);
    expect(first.req.user).toEqual({
      uid: 'firebase-uid-1',
      email: 'a@test.com',
      dbUserId: 'db-user-1',
      banned: false,
    });

    const second = buildReqRes();
    await authMiddleware(second.req, second.res, second.next);

    // Cache hit — no second DB round trip
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.req.user?.dbUserId).toBe('db-user-1');
    expect(second.req.user?.banned).toBe(false);
  });

  it('threads banned=true through so banCheckMiddleware can reject without a DB call', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-banned', email: 'b@test.com' });
    mockReturning.mockResolvedValue([{ id: 'db-user-2', banned: true }]);

    const { req, next } = buildReqRes();
    await authMiddleware(req, {} as Response, next);

    expect(req.user?.banned).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when the token is invalid, without touching the DB', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('bad token'));

    const { req, res, next } = buildReqRes('garbage');
    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
