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
import {
  getOutputModerationContext,
  markCompleted,
  markFailed,
  mergeGenerationParams,
} from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { sendGenerationComplete } from '../services/apnsService';
import { scanForCsam } from '../services/hiveService';
import { enforceFlaggedGeneration } from '../services/moderationEnforcementService';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { runFfmpegOp } from './ffmpegProcessor';
import { hiveScanQueue } from './hiveScanWorker';
import type { Adjustments } from '../config/adjustmentLut';

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

export type FfmpegOp = 'mux' | 'concat' | 'compose' | 'explainer_compose' | 'summary_compose';

export interface SpeedCurvePoint {
  /** Source-relative position across the trimmed clip, from 0 to 1. */
  position: number;
  /** Playback multiplier at this control point, from 0.1x to 10x. */
  rate: number;
}

// Phase 13 (Edit Studio) — 'compose' job type contract. Defines the shape the export pipeline
// (plans 06/07) dispatches into the queue; this plan only defines the contract, it does NOT
// implement the compose worker branch (that lives in ffmpegProcessor.ts, plan 06).
export interface ComposeClipSpec {
  r2Key: string;
  mediaType: 'video' | 'image';
  trimStartSeconds: number;
  trimEndSeconds: number;
  /** Linear source-audio gain. Optional only for backward compatibility with already-queued jobs. */
  volume?: number;
  /** Centered visual scale: 1 = aspect-fit, below 1 shrinks, above 1 crops. */
  scale?: number;
  /** Normalized center of the clip inside the output canvas. */
  xNorm?: number;
  yNorm?: number;
  /** Uniform source-speed multiplier. Defaults to 1 for already-queued jobs. */
  playbackRate?: number;
  /** Piecewise-linear source-speed curve. When valid, supersedes playbackRate. */
  speedCurve?: SpeedCurvePoint[] | null;
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
  /** Sketch 016: per-overlay style jsonb (see assCaptionBuilder.ts's TextOverlayStyleSpec).
   * Undefined → legacy fixed-white-Inter render. */
  style?: {
    font?: string;
    color?: string;
    background?: 'none' | 'pill' | 'block';
    backgroundColor?: string;
    bold?: boolean;
    outline?: boolean;
    shadow?: boolean;
    allCaps?: boolean;
    opacity?: number;
    fontSize?: number;
  };
}

export interface ComposeAudioSpec {
  r2Key: string;
  startOffsetSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  /** Phase 20.1 DAW mix gain (0..2, default 1) — applied as a volume filter at export time. */
  gain?: number;
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
  /** False renders each cue as ordinary static text instead of a word-level karaoke sweep. */
  karaoke?: boolean;
  /** Optional glyph outline and drop-shadow controls for burned captions. */
  outlineWidth?: number;
  shadowDepth?: number;
  /** False uses an outlined glyph instead of the default solid background pill. */
  backgroundBox?: boolean;
  position: 'top' | 'middle' | 'bottom';
  /** Item 3: optional continuous vertical anchor (0..1, box center) — see
   * assCaptionBuilder.ts's CaptionStyle.yOffsetNorm doc comment for the full contract. */
  yOffsetNorm?: number;
  // ─── Sketch 016 (2026-07-29) — all optional, all passthrough from caption_style jsonb; the
  // semantics live in assCaptionBuilder.ts's CaptionStyle doc comments.
  font?: string;
  timing?: 'word' | 'block' | 'karaoke';
  background?: 'none' | 'pill' | 'block';
  backgroundColor?: string;
  bold?: boolean;
  outline?: boolean;
  shadow?: boolean;
  allCaps?: boolean;
  opacity?: number;
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
  /**
   * Color filters, already in stack order (project_filters.z_index, then created_at).
   *
   * Optional so snapshots built before the feature — which are replayed verbatim on re-export —
   * decode unchanged and produce a byte-identical graph.
   */
  filters?: ComposeFilterSpec[];
}

/**
 * One color filter covering a window of the OUTPUT timeline. Unlike every other spec here it has
 * no source media: `filterId` names a .cube in assets/luts, and the same id resolves to the same
 * file in the iOS bundle so the on-device preview and this render agree.
 *
 * 2026-08-02 (Adjust tab): `filterId` became optional and `adjustments` was added so this same
 * spec can carry a compiled adjustment stack (brightness/contrast/...) instead of, or on top of, a
 * bundled look — mirrors project_filters' filter_id/adjustments nullability exactly. `adjustments`
 * is compiled to a 17^3 LUT at render time (src/config/adjustmentLut.ts, its byte-identical Swift
 * port on iOS) rather than applied as image operations — see that file for why. At least one of
 * `filterId`/`adjustments` is non-null for any row that reaches this spec; ffmpegProcessor.ts's
 * appendFilterChain skips a row where neither resolves to a LUT.
 */
export interface ComposeFilterSpec {
  filterId?: string;
  /** Compiled Adjust stack for this row, if any. See doc comment above. */
  adjustments?: Adjustments;
  /** 0 = invisible, 1 = the full look. Blended against the ungraded frame. */
  intensity: number;
  startOffsetSeconds: number;
  durationSeconds: number;
}

export interface ExplainerClipSpec {
  /** Omni-animated (or illustrated-motion) scene clip produced by the Explainer orchestrator. */
  r2Key: string;
  /** Real narration-stem duration for this scene; compose trims the clip to this exact value. */
  durationSeconds: number;
  /**
   * Transition INTO the next clip (nano-motion execution plan, 2026-07-23). 'cut' (default when
   * omitted) is the original hard concat — byte-identical to pre-existing behavior. 'morph'
   * crossfades this clip into the next via ffmpeg xfade instead. Meaningless on the last clip.
   */
  transition?: 'cut' | 'morph';
}

export interface ExplainerComposeSpec {
  width: number;
  height: number;
  fps: number;
  clips: ExplainerClipSpec[];
  narrationR2Key: string;
  musicR2Key: string | null;
  musicVolume: number;
  captionCues: ComposeCaptionCue[];
  captionStyle: ComposeCaptionStyle;
}

export interface SummarySourceClipSpec {
  startSeconds: number;
  endSeconds: number;
  /** Rendered duration. Summaries keep this equal to the selected source duration (natural speed). */
  outputDurationSeconds: number;
}

/**
 * How much of each source frame survives inside the square video window.
 * - `fill`     — full-bleed square crop (a 16:9 source loses ~44% of its width).
 * - `balanced` — crop no tighter than 4:3, then letterbox that inside the square (~25% width loss).
 * - `fit`      — whole source frame letterboxed inside the square (nothing cropped).
 * Only affects square windows (1:1 output, and the centered square inside 9:16).
 */
export type SummarySourceFraming = 'fill' | 'balanced' | 'fit';

/**
 * "Let the clip breathe" diegetic-audio beat (2026-07-25 spec). One OUTPUT-timeline window where
 * the original footage audio (`[0:a]`) should play at full volume instead of narration. Built by
 * videoSummaryWorker from a beat's own SummarySourceClipSpec entries — one window per underlying
 * clip, so a multi-clip diegetic beat threads through as multiple contiguous windows.
 */
export interface SummaryDiegeticWindow {
  /** Output-timeline seconds (post-concat) where this window starts/ends. */
  startSec: number;
  endSec: number;
  /** Source-timeline range to lift audio from — matches the same clip's video trim range. */
  sourceClipStartSec: number;
  sourceClipEndSec: number;
}

export interface SummaryComposeSpec {
  width: number;
  height: number;
  /** Defaults to 'fill' when absent, preserving pre-existing job payloads. */
  sourceFraming?: SummarySourceFraming;
  /** Portrait only: square's top-edge offset in canvas px. Absent = centered (legacy payloads). */
  portraitSquareTopPx?: number;
  sourceR2Key: string;
  clips: SummarySourceClipSpec[];
  narrationR2Key: string;
  musicR2Key: string | null;
  musicVolume: number;
  captionCues: ComposeCaptionCue[];
  captionStyle: ComposeCaptionStyle;
  /** Absent/empty = today's graph exactly (narration, or narration+music amix) — no `[0:a]` use. */
  diegeticWindows?: SummaryDiegeticWindow[];
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
  /** Required for op:'explainer_compose'. */
  explainerCompose?: ExplainerComposeSpec;
  /** Required for op:'summary_compose'. */
  summaryCompose?: SummaryComposeSpec;
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

  // Policy v2: only artifacts derived from a server-classified real-face path cross the
  // blocking output-scan boundary. This deliberately leaves Explainer and Edit Studio exports
  // unblocked, while still covering final faceswap/character-replace post-process artifacts.
  const moderationContext = await getOutputModerationContext(generationId);
  if (config.hiveScanRealFacePaths && moderationContext?.hasRealFaceInput) {
    try {
      const result = await scanForCsam(r2Key);
      if (result.flagged) {
        await enforceFlaggedGeneration(
          { generationId, r2Key, userId, costCredits: data.costCredits },
          result,
        );
        return;
      }
    } catch (hiveErr) {
      // Fail safe: the generic retry worker owns scan retries and completion. Never expose a
      // newly composed output merely because the first Hive request failed.
      console.error(`[ffmpeg-postprocess] Hive scan error for ${generationId} — queuing retry:`, hiveErr);
      await hiveScanQueue.add('scan', {
        generationId,
        r2Key,
        userId,
        costCredits: data.costCredits,
        mediaType,
      });
      console.log(`[ffmpeg-postprocess] Hive retry queued for generation ${generationId}`);
      return;
    }
  }

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
