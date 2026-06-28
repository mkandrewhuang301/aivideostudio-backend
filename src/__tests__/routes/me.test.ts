// src/__tests__/routes/me.test.ts
// Unit tests for PATCH /api/me/device-token and PATCH /api/me/preferences.
// All DB calls are mocked: no live Neon connection required.

jest.mock('../../config', () => ({ config: {} }));

const mockExecute = jest.fn();
jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
  },
}));

jest.mock('../../services/creditService', () => ({
  getUserWithBalance: jest.fn().mockResolvedValue({
    credits_balance: 0,
    subscription_allotment: 0,
    active_topup_balance: 0,
    entitlement_level: null,
  }),
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { meRouter } from '../../routes/me';

// ─── Test app helper ──────────────────────────────────────────────────────────

function buildApp(user: { uid: string; dbUserId: string } | null) {
  const app = express();
  app.use(express.json());

  // Simulate authMiddleware: inject req.user
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });

  app.use('/api/me', meRouter);
  return app;
}

// ─── PATCH /api/me/device-token ───────────────────────────────────────────────

describe('PATCH /api/me/device-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
  });

  it('returns 204 and updates apns_device_token for an authenticated user', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .patch('/api/me/device-token')
      .send({ deviceToken: 'abc123' });

    expect(res.status).toBe(204);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const queryArg = mockExecute.mock.calls[0][0];
    expect(JSON.stringify(queryArg)).toContain('apns_device_token');
  });

  it('returns 400 MISSING_DEVICE_TOKEN when deviceToken is missing', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app).patch('/api/me/device-token').send({});

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
});

// ─── PATCH /api/me/preferences ─────────────────────────────────────────────────

describe('PATCH /api/me/preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
  });

  it('returns 204 and updates onboarding_preferences for an authenticated user', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

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

  it('returns 400 MISSING_PREFERENCES when preferences key is missing', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app).patch('/api/me/preferences').send({});

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
});
