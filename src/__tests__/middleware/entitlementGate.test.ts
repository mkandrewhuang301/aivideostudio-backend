// src/__tests__/middleware/entitlementGate.test.ts
// Tests for entitlementGate — tier gating for POST /api/generations (paywall-tiers-plan.md
// Part 1, items 2-3). Covers: basic user + premium model -> 403; pro user + premium model ->
// passes; 1080p requires pro; 4k requires creator; NULL entitlement -> 403 (hard paywall); DB
// error -> fail-safe 403.

const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

import { Request, Response, NextFunction } from 'express';
import { entitlementGate } from '../../middleware/entitlementGate';

// dbUserId: pass null (not undefined — a default parameter does not trigger on an explicitly
// passed undefined) to simulate an unauthenticated request.
function makeReqResNext(
  resolved: Record<string, unknown> | undefined,
  dbUserId: string | null = 'user-1',
) {
  const req = { _resolved: resolved, user: dbUserId ? { dbUserId } : undefined } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

function mockEntitlement(level: string | null) {
  mockExecute.mockResolvedValue({ rows: [{ entitlement_level: level }] });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('entitlementGate', () => {
  it('no-ops when req._resolved is missing (nothing to gate yet)', async () => {
    const { req, res, next } = makeReqResNext(undefined);
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('no-ops when req.user.dbUserId is missing (auth guard runs elsewhere)', async () => {
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini' }, null);
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows a basic user to dispatch a core model (basic requirement)', async () => {
    mockEntitlement('basic');
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a basic user dispatching a premium model with 403 TIER_REQUIRED', async () => {
    mockEntitlement('basic');
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_REQUIRED', required_tier: 'pro' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a pro user to dispatch a premium model (HappyHorse 1.1)', async () => {
    mockEntitlement('pro');
    const { req, res, next } = makeReqResNext({ model: 'alibaba/happyhorse-1.1', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a basic user requesting 1080p on a core model with required_tier pro', async () => {
    mockEntitlement('basic');
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0', resolution: '1080p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ required_tier: 'pro' }));
  });

  it('blocks a pro user requesting 4k with required_tier creator', async () => {
    mockEntitlement('pro');
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0', resolution: '4k' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ required_tier: 'creator' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a creator user to request 4k', async () => {
    mockEntitlement('creator');
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0', resolution: '4k' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a NULL entitlement (no active subscription) even on a core model — hard paywall', async () => {
    mockEntitlement(null);
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_REQUIRED', required_tier: 'basic' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a missing user row (no rows returned) the same as NULL entitlement', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails safe (blocks with 403) when the DB query throws', async () => {
    mockExecute.mockRejectedValue(new Error('connection lost'));
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_CHECK_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a creator user to dispatch any model at any resolution', async () => {
    mockEntitlement('creator');
    const { req, res, next } = makeReqResNext({ model: 'fal-ai/kling-video/v3/standard/image-to-video' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
