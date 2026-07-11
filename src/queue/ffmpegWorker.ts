// src/queue/ffmpegWorker.ts
// BullMQ worker for the ffmpeg post-process stage (D-06): audio mux (video + trend/ambience
// audio -> one MP4) and clip concat (N clips -> one MP4). Modeled on hiveScanWorker.ts's
// Queue/Worker + completion-rejoin + final-failure pattern.
//
// This worker runs AFTER a Replicate generation's raw clip(s) are already archived to R2 by the
// webhook — a preset flag on the generation enqueues this job instead of marking the generation
// complete immediately (RESEARCH.md #1). Real download/ffmpeg-spawn/R2-upload I/O lives in
// ffmpegProcessor.ts — a single mockable seam so this file's BullMQ lifecycle + completion path
// (markCompleted + APNs) can be unit tested without a live ffmpeg binary, network fetch, or R2
// credentials, exactly like hiveScanWorker.processHiveScan is tested.

import { Queue, Worker, Job } from 'bullmq';
import { execFile } from 'child_process';
import { config } from '../config';
import { markCompleted, markFailed } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { sendGenerationComplete } from '../services/apnsService';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { runFfmpegOp } from './ffmpegProcessor';

const QUEUE_NAME = 'ffmpeg-postprocess';
export const FFMPEG_ATTEMPTS = 3;
// T-09.3-04: bound concurrency — ffmpeg is CPU/memory-heavy; unbounded concurrency on a shared
// Railway container risks resource exhaustion (a DoS vector if job volume spikes).
const WORKER_CONCURRENCY = 2;
const RETRY_DELAY_MS = 10_000;

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export type FfmpegOp = 'mux' | 'concat';

export interface FfmpegJobData {
  generationId: string;
  userId: string;
  costCredits: number;
  op: FfmpegOp;
  /** R2 keys for video clip(s). mux uses [0]; concat uses all in order. */
  inputR2Keys: string[];
  /** Required for op:'mux' — trend/ambience audio R2 key. */
  audioR2Key?: string;
  mediaType: 'video';
}

export const ffmpegQueue = new Queue<FfmpegJobData>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: FFMPEG_ATTEMPTS,
    backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

// SC1 build/startup smoke signal — Railway deploy logs should show the ffmpeg version line so a
// missing binary (nixpacks misconfiguration) is caught immediately rather than surfacing later as
// silent job failures. Skipped under test — child_process is intentionally NOT mocked in
// ffmpegWorker.test.ts (real subprocess I/O has no place in a unit test), so this module-load
// side effect would otherwise spawn a real, unawaited process during every test run.
if (config.nodeEnv !== 'test') {
  execFile('ffmpeg', ['-version'], (err, stdout) => {
    if (err) {
      console.warn('[ffmpeg-postprocess] ffmpeg binary not found on PATH:', err.message);
      return;
    }
    console.log(`[ffmpeg-postprocess] ${stdout.split('\n')[0]}`);
  });
}

// Exported for testing — BullMQ retries this automatically on throw.
export async function processFfmpegJob(data: FfmpegJobData): Promise<void> {
  const { generationId, userId, mediaType } = data;

  const r2Key = await runFfmpegOp(data);

  const completed = await markCompleted(generationId, r2Key);
  if (completed) {
    try {
      const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
      const token = (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token;
      if (token) await sendGenerationComplete(token, generationId, mediaType);
    } catch (pushErr) {
      console.error('[ffmpeg-postprocess] Push notification failed (non-blocking):', pushErr);
    }
    console.log(`[ffmpeg-postprocess] Generation ${generationId} completed (${data.op})`);
  }
}

// Exported for testing — called when all retry attempts are exhausted.
export async function handleFfmpegFinalFailure(data: FfmpegJobData, err: Error): Promise<void> {
  const { generationId, userId, costCredits } = data;
  console.error(`[ffmpeg-postprocess] All ${FFMPEG_ATTEMPTS} attempts failed for ${generationId} — failing and refunding:`, err);
  await markFailed(generationId).catch((e) => console.error('[ffmpeg-postprocess] markFailed error:', e));
  await refundCredits(userId, costCredits, `ffmpeg-timeout-${generationId}`).catch((e) =>
    console.error('[ffmpeg-postprocess] refundCredits error:', e),
  );
}

export const ffmpegWorker = new Worker<FfmpegJobData>(
  QUEUE_NAME,
  (job: Job<FfmpegJobData>) => processFfmpegJob(job.data),
  { connection: connectionOptions, concurrency: WORKER_CONCURRENCY },
);

ffmpegWorker.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < FFMPEG_ATTEMPTS) return;
  await handleFfmpegFinalFailure(job.data, err);
});
