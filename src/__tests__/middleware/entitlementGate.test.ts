// src/__tests__/middleware/entitlementGate.test.ts
// Tests for entitlementGate — tier gating for POST /api/generations (paywall-tiers-plan.md
// Part 1, items 2-3). Covers: basic user + premium model -> 403; pro user + premium model ->
// passes; 1080p requires pro; 4k requires creator; NULL entitlement passes basic only; DB error
// -> fail-safe 403.

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
  preset?: Record<string, unknown>,
) {
  const req = {
    _resolved: resolved,
    user: dbUserId ? { dbUserId } : undefined,
    ...(preset ? { _preset: preset } : {}),
  } as unknown as Request;
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

  it('allows a NULL entitlement guest to dispatch a basic 720p core model', async () => {
    mockEntitlement(null);
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks a NULL entitlement guest from requesting 1080p with required_tier pro', async () => {
    mockEntitlement(null);
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '1080p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_REQUIRED', required_tier: 'pro' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks a NULL entitlement guest from requesting a 4k creator generation', async () => {
    mockEntitlement(null);
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '4k' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_REQUIRED', required_tier: 'creator' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('treats a missing user row (no rows returned) like a NULL entitlement for basic access', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('fails safe (blocks with 403) when the DB query throws', async () => {
    mockExecute.mockRejectedValue(new Error('connection lost'));
    const { req, res, next } = makeReqResNext({ model: 'bytedance/seedance-2.0-mini', resolution: '720p' });
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_CHECK_ERROR' }));
    expect(next).not.toHaveBeenCalled();
  });

  // Presets are tier-agnostic: any preset is open to every user regardless of the (possibly pro)
  // model or resolution powering it. Gating applies only to freeform (no _preset) requests.
  it('allows a basic user to run a preset on a pro model (no min_tier) — presets never inherit model tier', async () => {
    mockEntitlement('basic');
    const { req, res, next } = makeReqResNext(
      { model: 'alibaba/happyhorse-1.1', resolution: '720p' },
      'user-1',
      { preset_id: 'you-vs-you', input_upload_ids: [] },
    );
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows a NULL guest to run a Kling preset (no min_tier) at 1080p — model AND resolution gate skipped for presets', async () => {
    mockEntitlement(null);
    const { req, res, next } = makeReqResNext(
      { model: 'fal-ai/kling-video/o3/standard/reference-to-video', resolution: '1080p' },
      'user-1',
      { preset_id: 'gorilla-vlogs', input_upload_ids: [] },
    );
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('still honors an explicit preset min_tier as an escape hatch: basic user + pro preset -> 403', async () => {
    mockEntitlement('basic');
    const { req, res, next } = makeReqResNext(
      { model: 'bytedance/seedance-2.0-mini', resolution: '720p' },
      'user-1',
      { preset_id: 'some-premium-preset', input_upload_ids: [], min_tier: 'pro' },
    );
    await entitlementGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIER_REQUIRED', required_tier: 'pro' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a creator user to dispatch any model at any resolution', async () => {
    mockEntitlement('creator');
    const { req, res, next } = makeReqResNext({ model: 'fal-ai/kling-video/v3/standard/image-to-video' });
    await entitlementGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
