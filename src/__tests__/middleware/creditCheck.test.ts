// src/__tests__/middleware/creditCheck.test.ts
// Tests for creditCheckMiddleware — atomic credit deduction gate (CLAUDE.md Rule 1).
// Verifies invalid input rejection, auth guard, 402 on insufficient credits, and success path.

jest.mock('../../config', () => ({ config: {} }));

jest.mock('../../services/creditService', () => ({
  deductCredits: jest.fn(),
}));

import { Request, Response, NextFunction } from 'express';
import { creditCheckMiddleware } from '../../middleware/creditCheck';
import { deductCredits } from '../../services/creditService';

const mockDeductCredits = deductCredits as jest.Mock;

function makeReqResNext(
  body: Record<string, unknown>,
  user?: { dbUserId: string },
) {
  const req = { body, user } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('creditCheckMiddleware — input validation', () => {
  it('returns 400 INVALID_COST when cost_credits is missing from body', async () => {
    const { req, res, next } = makeReqResNext({}, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_COST' }));
    expect(next).not.toHaveBeenCalled();
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_COST when cost_credits is 0 (not a positive integer)', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: 0 }, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_COST' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_COST when cost_credits is negative', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: -50 }, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_COST' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_COST when cost_credits is a float (non-integer)', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: 12.5 }, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_COST' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_COST when cost_credits is a non-numeric string', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: 'banana' }, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_COST' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_COST when cost_credits is null', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: null }, { dbUserId: 'user-1' });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('creditCheckMiddleware — auth guard', () => {
  it('returns 401 UNAUTHENTICATED when req.user is undefined', async () => {
    const { req, res, next } = makeReqResNext({ cost_credits: 50 });
    await creditCheckMiddleware(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(next).not.toHaveBeenCalled();
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });
});

// ─── Credit deduction ─────────────────────────────────────────────────────────

describe('creditCheckMiddleware — credit deduction', () => {
  it('returns 402 INSUFFICIENT_CREDITS when deductCredits returns false', async () => {
    mockDeductCredits.mockResolvedValue(false);
    const { req, res, next } = makeReqResNext({ cost_credits: 100 }, { dbUserId: 'user-1' });

    await creditCheckMiddleware(req, res, next);

    expect(mockDeductCredits).toHaveBeenCalledWith('user-1', 100);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(402);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_CREDITS' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.generationCost when deductCredits returns true', async () => {
    mockDeductCredits.mockResolvedValue(true);
    const { req, res, next } = makeReqResNext({ cost_credits: 60 }, { dbUserId: 'user-1' });

    await creditCheckMiddleware(req, res, next);

    expect(mockDeductCredits).toHaveBeenCalledWith('user-1', 60);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as Request & { generationCost?: number }).generationCost).toBe(60);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 500 when deductCredits throws unexpectedly', async () => {
    mockDeductCredits.mockRejectedValue(new Error('DB connection lost'));
    const { req, res, next } = makeReqResNext({ cost_credits: 50 }, { dbUserId: 'user-1' });

    await creditCheckMiddleware(req, res, next);

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('coerces string cost_credits to number via Number() before passing to deductCredits', async () => {
    mockDeductCredits.mockResolvedValue(true);
    // Express body-parser may deliver numeric body fields as strings in some contexts
    const { req, res, next } = makeReqResNext({ cost_credits: '75' }, { dbUserId: 'user-1' });

    await creditCheckMiddleware(req, res, next);

    // Middleware does Number('75') → 75
    expect(mockDeductCredits).toHaveBeenCalledWith('user-1', 75);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes the exact cost value into deductCredits (CLAUDE.md Rule 1: atomic deduction)', async () => {
    mockDeductCredits.mockResolvedValue(true);
    const { req, res, next } = makeReqResNext({ cost_credits: 38 }, { dbUserId: 'db-user-uuid-2' });

    await creditCheckMiddleware(req, res, next);

    expect(mockDeductCredits).toHaveBeenCalledWith('db-user-uuid-2', 38);
  });
});
