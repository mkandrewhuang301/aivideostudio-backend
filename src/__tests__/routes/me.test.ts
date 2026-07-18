// src/__tests__/routes/me.test.ts
// Stress-tests for GET /api/me, PATCH /api/me/device-token, PATCH /api/me/preferences.
// All DB calls are mocked: no live Neon connection required.

jest.mock('../../config', () => ({ config: {} }));

const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
  },
}));

const mockGetUserWithBalance = jest.fn();
jest.mock('../../services/creditService', () => ({
  getUserWithBalance: mockGetUserWithBalance,
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { meRouter } from '../../routes/me';

// ─── Test app helper ──────────────────────────────────────────────────────────

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

const AUTHED_USER = { uid: 'firebase-uid-1', email: 'test@example.com', dbUserId: 'db-user-uuid-1' };

const BALANCE_STUB = {
  credits_balance: 100,
  subscription_allotment: 50,
  active_topup_balance: 50,
  entitlement_level: 'pro',
};

// ─── GET /api/me ─────────────────────────────────────────────────────────────

describe('GET /api/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserWithBalance.mockResolvedValue(BALANCE_STUB);
    mockExecute.mockResolvedValue({ rows: [{ face_consent_at: null }] });
  });

  it('returns 200 with user and balance fields for authenticated user', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { uid: 'firebase-uid-1', email: 'test@example.com' },
      credits_balance: 100,
      subscription_allotment: 50,
      active_topup_balance: 50,
      entitlement_level: 'pro',
    });
    expect(mockGetUserWithBalance).toHaveBeenCalledWith('db-user-uuid-1');
  });

  it('returns 401 when there is no authenticated user', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(401);
    expect(mockGetUserWithBalance).not.toHaveBeenCalled();
  });

  it('returns 500 when getUserWithBalance throws', async () => {
    mockGetUserWithBalance.mockRejectedValueOnce(new Error('DB connection lost'));
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch user data');
  });

  it('returns has_face_consent: true when face_consent_at is non-null', async () => {
    mockExecute.mockResolvedValue({ rows: [{ face_consent_at: '2026-07-08T00:00:00.000Z' }] });
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body.has_face_consent).toBe(true);
  });

  it('returns has_face_consent: false when face_consent_at is null', async () => {
    mockExecute.mockResolvedValue({ rows: [{ face_consent_at: null }] });
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body.has_face_consent).toBe(false);
  });

  // Paywall tiers (paywall-tiers-plan.md item 5): tier + parallel_limit derived from
  // entitlement_level, so the client can label locked models/surface concurrency without
  // hardcoding the tier ladder.
  it('returns tier and parallel_limit derived from entitlement_level (pro -> 2)', async () => {
    mockGetUserWithBalance.mockResolvedValue({ ...BALANCE_STUB, entitlement_level: 'pro' });
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('pro');
    expect(res.body.parallel_limit).toBe(2);
  });

  it('returns tier and parallel_limit derived from entitlement_level (creator -> 4)', async () => {
    mockGetUserWithBalance.mockResolvedValue({ ...BALANCE_STUB, entitlement_level: 'creator' });
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.body.tier).toBe('creator');
    expect(res.body.parallel_limit).toBe(4);
  });

  it('returns tier: null and parallel_limit: null when entitlement_level is NULL', async () => {
    mockGetUserWithBalance.mockResolvedValue({ ...BALANCE_STUB, entitlement_level: null });
    const app = buildApp(AUTHED_USER);
    const res = await request(app).get('/api/me');

    expect(res.body.tier).toBeNull();
    expect(res.body.parallel_limit).toBeNull();
  });
});

// ─── PATCH /api/me/device-token ───────────────────────────────────────────────

describe('PATCH /api/me/device-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
    mockGetUserWithBalance.mockResolvedValue(BALANCE_STUB);
  });

  it('returns 204 and updates apns_device_token for an authenticated user', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 'abc123devicetoken' });

    expect(res.status).toBe(204);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('apns_device_token');
  });

  it('returns 400 MISSING_DEVICE_TOKEN when deviceToken key is absent', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app).patch('/api/me/device-token').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when deviceToken is an empty string', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when deviceToken is a number', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when deviceToken is explicitly null', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when deviceToken is an array', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: ['abc123'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when deviceToken is boolean true', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_TOKEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated user', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 'abc123' });

    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 500 when db.execute throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('DB connection lost'));
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 'abc123' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update device token');
  });

  it('includes the device token value in the UPDATE query', async () => {
    const app = buildApp(AUTHED_USER);
    await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 'unique-apns-token-xyz' });

    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('unique-apns-token-xyz');
  });
});

// ─── PATCH /api/me/preferences ─────────────────────────────────────────────────

describe('PATCH /api/me/preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
    mockGetUserWithBalance.mockResolvedValue(BALANCE_STUB);
  });

  it('returns 204 and updates onboarding_preferences for an authenticated user', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({
        preferences: {
          familiarity: ['Some experience'],
          useCase: ['Social media'],
          style: ['Anime'],
          conditional: ['TikTok'],
        },
      });

    expect(res.status).toBe(204);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('onboarding_preferences');
  });

  it('returns 204 when preferences is an empty object', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: {} });

    expect(res.status).toBe(204);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns 400 MISSING_PREFERENCES when preferences key is absent', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app).patch('/api/me/preferences').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PREFERENCES');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when preferences is explicitly null', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PREFERENCES');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when preferences is a string', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: 'some-string' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PREFERENCES');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when preferences is a number', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: 42 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PREFERENCES');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 when preferences is an array (array passes typeof object — Array.isArray guard required)', async () => {
    // Bug: typeof [] === 'object' and ![] is false, so the original check
    // (!preferences || typeof preferences !== 'object') would pass an array through.
    // The fix adds || Array.isArray(preferences) to the guard in me.ts.
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: ['Social media', 'Anime'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PREFERENCES');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated user', async () => {
    const app = buildApp(null);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: { familiarity: ['Some experience'] } });

    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 500 when db.execute throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('Neon timeout'));
    const app = buildApp(AUTHED_USER);
    const res = await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: { familiarity: ['Power user'] } });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update preferences');
  });

  it('serializes preferences as JSON in the UPDATE query', async () => {
    const prefs = { familiarity: ['Power user'], useCase: ['Cinematic/filmmaking'] };
    const app = buildApp(AUTHED_USER);
    await request(app)
      .patch('/api/me/preferences')
      .send({ preferences: prefs });

    const queryArg = mockExecute.mock.calls[0][0];
    const queryStr = JSON.stringify(queryArg);
    // The stringified prefs should appear in the SQL template literal params
    expect(queryStr).toContain('Power user');
    expect(queryStr).toContain('Cinematic/filmmaking');
  });
});

// ─── PATCH /api/me/consent ──────────────────────────────────────────────────

describe('PATCH /api/me/consent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
    mockGetUserWithBalance.mockResolvedValue(BALANCE_STUB);
  });

  it('returns 204 and issues an UPDATE touching face_consent_at for an authenticated user', async () => {
    const app = buildApp(AUTHED_USER);
    const res = await request(app).patch('/api/me/consent').send({});

    expect(res.status).toBe(204);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('face_consent_at');
  });

  it('scopes the UPDATE to the authenticated user id', async () => {
    const app = buildApp(AUTHED_USER);
    await request(app).patch('/api/me/consent').send({});

    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('db-user-uuid-1');
  });

  it('returns 401 when there is no authenticated user', async () => {
    const app = buildApp(null);
    const res = await request(app).patch('/api/me/consent').send({});

    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 500 when db.execute throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('DB connection lost'));
    const app = buildApp(AUTHED_USER);
    const res = await request(app).patch('/api/me/consent').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to record consent');
  });
});
