// src/__tests__/middleware/concurrencyGate.test.ts
// Tests for concurrencyGate — per-tier active-generation concurrency cap (paywall-tiers-plan.md
// Part 1, item 4): basic 1, pro 2, creator 4. Covers: basic user at cap -> 429; pro user under
// cap -> passes; creator user at cap (4) -> 429 on the 5th; DB error -> fail-safe 429.

const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

import { Request, Response, NextFunction } from 'express';
import { concurrencyGate } from '../../middleware/concurrencyGate';

// dbUserId: pass null (not undefined — a default parameter does not trigger on an explicitly
// passed undefined) to simulate an unauthenticated request.
function makeReqResNext(dbUserId: string | null = 'user-1') {
  const req = { user: dbUserId ? { dbUserId } : undefined } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

// concurrencyGate calls getUserTier() (SELECT entitlement_level) then countActiveGenerations()
// (SELECT COUNT(*)) — two sequential db.execute calls in that order.
function mockTierThenCount(level: string | null, count: number) {
  mockExecute
    .mockResolvedValueOnce({ rows: [{ entitlement_level: level }] })
    .mockResolvedValueOnce({ rows: [{ count }] });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('concurrencyGate', () => {
  it('no-ops when req.user.dbUserId is missing', async () => {
    const { req, res, next } = makeReqResNext(null);
    await concurrencyGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows a basic user with 0 active generations (limit 1)', async () => {
    mockTierThenCount('basic', 0);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a basic user with 1 active generation (at cap) with 429 CONCURRENCY_LIMIT', async () => {
    mockTierThenCount('basic', 1);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONCURRENCY_LIMIT', limit: 1 }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a pro user with 1 active generation (limit 2)', async () => {
    mockTierThenCount('pro', 1);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks a pro user with 2 active generations (at cap) with limit 2', async () => {
    mockTierThenCount('pro', 2);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it('allows a creator user with 3 active generations (limit 4)', async () => {
    mockTierThenCount('creator', 3);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks a creator user with 4 active generations (at cap) — 429 on the 5th attempt', async () => {
    mockTierThenCount('creator', 4);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONCURRENCY_LIMIT', limit: 4 }));
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to the basic limit when entitlement is NULL (defensive — entitlementGate already blocks this case upstream)', async () => {
    mockTierThenCount(null, 1);
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it('fails safe (blocks with 429) when the DB query throws', async () => {
    mockExecute.mockRejectedValue(new Error('connection lost'));
    const { req, res, next } = makeReqResNext();
    await concurrencyGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONCURRENCY_CHECK_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });
});
