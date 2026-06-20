// src/routes/health.ts
import { Router, Request, Response } from 'express';
import { db } from '../db/client';
import { redis } from '../redis/client';
import { r2, R2_BUCKET } from '../storage/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = {};

  // Postgres check
  try {
    await db.execute(sql`SELECT 1`);
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
  }

  // Redis check
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }

  // R2 check
  try {
    await r2.send(new HeadBucketCommand({ Bucket: R2_BUCKET }));
    checks.r2 = 'ok';
  } catch {
    checks.r2 = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks });
});
