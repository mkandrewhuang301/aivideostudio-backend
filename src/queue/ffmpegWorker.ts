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
import { markCompleted, markFailed, mergeGenerationParams } from '../services/generationService';
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

export type FfmpegOp = 'mux' | 'concat' | 'compose';

// Phase 13 (Edit Studio) — 'compose' job type contract. Defines the shape the export pipeline
// (plans 06/07) dispatches into the queue; this plan only defines the contract, it does NOT
// implement the compose worker branch (that lives in ffmpegProcessor.ts, plan 06).
export interface ComposeClipSpec {
  r2Key: string;
  mediaType: 'video' | 'image';
  trimStartSeconds: number;
  trimEndSeconds: number;
}

export interface ComposeTextSpec {
  text: string;
  xNorm: number;
  yNorm: number;
  /** Scale factor (1 = default size). Threaded through to the libass render path (G4)'s \fs. */
  widthNorm?: number;
  /** Degrees, clockwise-positive (SwiftUI .rotationEffect convention — see schema.ts's rotation column doc). */
  rotation?: number;
  startSeconds: number;
  endSeconds: number;
}

export interface ComposeAudioSpec {
  r2Key: string;
  startOffsetSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
}

export interface ComposeCaptionCue {
  startSeconds: number;
  endSeconds: number;
  words: { text: string; startSeconds: number; endSeconds: number }[];
}

export interface ComposeCaptionStyle {
  fontSize: number;
  color: string;
  highlightColor: string;
  position: 'top' | 'middle' | 'bottom';
}

export interface ComposeSpec {
  // Plan 13-22 B2: 'original' = the first clip's exact native pixel ratio (not snapped to a
  // preset) — resolved at snapshot-build time (buildComposeSnapshot) into
  // originalCanvasWidth/originalCanvasHeight below.
  aspectRatio: '9:16' | '4:5' | '1:1' | '16:9' | 'original';
  /** Only meaningful when aspectRatio === 'original' — the first (sort_order) non-deleted clip's
   * stored pixel dimensions, RAW (not yet even-forced — resolveComposeCanvas does that). Undefined
   * when unresolvable (no clips, or the first clip's dimensions were never probed); the canvas
   * resolver falls back to 1080x1920 in that case. */
  originalCanvasWidth?: number;
  originalCanvasHeight?: number;
  clips: ComposeClipSpec[];
  textOverlays: ComposeTextSpec[];
  audioClips: ComposeAudioSpec[];
  captionCues: ComposeCaptionCue[];
  captionStyle: ComposeCaptionStyle;
}

export interface FfmpegJobData {
  generationId: string;
  userId: string;
  costCredits: number;
  op: FfmpegOp;
  /** R2 keys for video clip(s). mux uses [0]; concat uses all in order. Unused (pass []) for compose. */
  inputR2Keys: string[];
  /** Required for op:'mux' — trend/ambience audio R2 key. */
  audioR2Key?: string;
  mediaType: 'video';
  /** Required for op:'compose' (plan 06 implements the worker branch that consumes this). */
  compose?: ComposeSpec;
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

  const { r2Key, masterR2Key } = await runFfmpegOp(data);

  const completed = await markCompleted(generationId, r2Key);
  if (completed) {
    // D-04: stamp the silent-master + applied-audio pointers on the row (mux only — concat has no
    // single silent source, masterR2Key is undefined). Best-effort, like the APNs block below —
    // never blocks or fails the job over a bookkeeping write.
    if (masterR2Key) {
      try {
        await mergeGenerationParams(generationId, {
          silent_master_r2_key: masterR2Key,
          applied_audio_r2_key: data.audioR2Key ?? null,
        });
      } catch (paramsErr) {
        console.error('[ffmpeg-postprocess] mergeGenerationParams failed (non-blocking):', paramsErr);
      }
    }
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
