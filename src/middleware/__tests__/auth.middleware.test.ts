import { Request, Response, NextFunction } from 'express';

// Mock firebase.ts before importing authMiddleware
jest.mock('../../firebase', () => ({
  getFirebaseAdmin: jest.fn().mockReturnValue({
    auth: {
      verifyIdToken: jest.fn(),
    },
  }),
}));

// Mock db client
jest.mock('../../db/client', () => ({
  db: {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 'test-db-uuid' }]),
        }),
      }),
    }),
  },
}));

import { authMiddleware } from '../auth';
import { getFirebaseAdmin } from '../../firebase';

const mockGetFirebaseAdmin = getFirebaseAdmin as jest.MockedFunction<typeof getFirebaseAdmin>;

function makeRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = { headers: {} } as Request;
    const res = makeRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header lacks Bearer prefix', async () => {
    const req = { headers: { authorization: 'Basic abc123' } } as Request;
    const res = makeRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 TOKEN_EXPIRED when verifyIdToken throws auth/id-token-expired', async () => {
    const expiredError = { code: 'auth/id-token-expired' };
    (mockGetFirebaseAdmin().auth.verifyIdToken as jest.Mock).mockRejectedValueOnce(expiredError);
    const req = { headers: { authorization: 'Bearer expired-token' } } as Request;
    const res = makeRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 TOKEN_INVALID on unknown firebase error', async () => {
    (mockGetFirebaseAdmin().auth.verifyIdToken as jest.Mock).mockRejectedValueOnce(new Error('unknown'));
    const req = { headers: { authorization: 'Bearer bad-token' } } as Request;
    const res = makeRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_INVALID' }));
  });

  it('calls next() and sets req.user on valid token', async () => {
    (mockGetFirebaseAdmin().auth.verifyIdToken as jest.Mock).mockResolvedValueOnce({
      uid: 'firebase-uid-123',
      email: 'test@example.com',
    });
    const req = { headers: { authorization: 'Bearer valid-token' } } as unknown as Request;
    const res = makeRes() as Response;
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as Request).user).toMatchObject({ uid: 'firebase-uid-123', email: 'test@example.com' });
  });
});
