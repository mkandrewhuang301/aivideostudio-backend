// src/__tests__/routes/reports.test.ts
// Unit tests for POST /api/reports and banCheckMiddleware.
// All DB calls are mocked: no live Neon connection required.

jest.mock('../../config', () => ({ config: {} }));

const mockExecute = jest.fn();
const mockInsertValues = jest.fn();
jest.mock('../../db/client', () => ({
  db: {
    execute: mockExecute,
    insert: jest.fn().mockReturnValue({ values: mockInsertValues }),
  },
}));

import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { reportsRouter } from '../../routes/reports';
import { banCheckMiddleware } from '../../middleware/banCheck';

// ─── Test app helper ──────────────────────────────────────────────────────────

function buildApp(user: { uid: string; dbUserId: string } | null) {
  const app = express();
  app.use(express.json());

  // Simulate authMiddleware: inject req.user
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) req.user = user;
    next();
  });

  app.use('/api/reports', reportsRouter);
  return app;
}

// ─── POST /api/reports ────────────────────────────────────────────────────────

describe('POST /api/reports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
  });

  it('returns 201 when generation belongs to the authenticated user', async () => {
    // ownership check returns a row (generation owned by user)
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'gen-uuid' }] });

    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .post('/api/reports')
      .send({
        generation_id: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'inappropriate_content',
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: 'Report received. Thank you.' });
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  it('returns 403 NOT_YOUR_GENERATION when generation belongs to a different user', async () => {
    // ownership check returns no rows (generation not owned by this user)
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .post('/api/reports')
      .send({
        generation_id: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'inappropriate_content',
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', code: 'NOT_YOUR_GENERATION' });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_REASON when reason is not in the valid set', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .post('/api/reports')
      .send({
        generation_id: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'banana',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
    // DB should not have been queried at all
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns 400 MISSING_GENERATION_ID when generation_id is absent', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .post('/api/reports')
      .send({ reason: 'other' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_GENERATION_ID');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_GENERATION_ID for a malformed UUID — prevents PostgreSQL cast error', async () => {
    const app = buildApp({ uid: 'firebase-uid-1', dbUserId: 'db-user-uuid-1' });

    const res = await request(app)
      .post('/api/reports')
      .send({ generation_id: 'not-a-uuid', reason: 'other' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GENERATION_ID');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── banCheckMiddleware ───────────────────────────────────────────────────────
// Perf: banCheckMiddleware no longer queries the DB itself — it reads req.user.banned,
// populated by authMiddleware's upsert/cache (see auth.ts). No DB mocking needed here.

describe('banCheckMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 403 Account suspended and does not call next() when req.user.banned is true', () => {
    const req = { user: { dbUserId: 'some-uuid', banned: true } } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    banCheckMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith({ error: 'Account suspended' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when req.user.banned is false', () => {
    const req = { user: { dbUserId: 'some-uuid', banned: false } } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    banCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when req.user.banned is undefined (e.g. no user context)', () => {
    const req = { user: undefined } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;

    banCheckMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
