// src/routes/health.ts
import { Router, Request, Response } from 'express';
import { db } from '../db/client';
import { redis } from '../redis/client';
import { r2, R2_BUCKET } from '../storage/r2';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { execFileSync } from 'child_process';

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

  // ffmpeg probe (SC1 / D-06) — non-blocking: kept OUT of the `checks` allOk aggregation below so
  // a missing binary in local dev never flips the overall /health HTTP status; Railway must show
  // `ok` after deploy (manually verified in 09.3-08) since the nixpacks ffmpeg worker needs it.
  let ffmpegStatus: 'ok' | 'missing';
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    ffmpegStatus = 'ok';
  } catch {
    ffmpegStatus = 'missing';
    console.warn('[health] ffmpeg binary not found on PATH');
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  // Railway injects RAILWAY_GIT_COMMIT_SHA automatically; absent in local dev.
  const version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks: { ...checks, ffmpeg: ffmpegStatus },
    version,
  });
});
