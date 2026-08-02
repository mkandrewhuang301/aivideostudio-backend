// src/services/videoBackgroundRemovalService.ts
// Video Background Removal service layer — quote, ownership scoping, atomic credit deduction,
// refund, status transitions, media swap, and undo. This is the money + correctness core
// (CLAUDE.md rule #1: single guarded UPDATE, never SELECT-then-UPDATE; rule #7: duration resolved
// server-side in explicit seconds). Closest analog: audioSeparationService.ts, whose quote ->
// idempotent atomic-deduct create -> mark-processing -> complete -> refund shape is copied
// wholesale.
//
// ─── How the result lands in the project (differs from audio separation) ──────
// Separation ADDS stem rows and mutes the source. Background removal REPLACES the source clip's
// media: project_clips.r2_key is swapped to the processed object, and the clip's prior r2_key is
// captured into video_background_removal_jobs.source_prior_r2_key so undo can restore it exactly.
//
// The swap is deliberately TIMEBASE-PRESERVING: the whole source clip is processed (not the
// trimmed window), so the output has the same duration and frame timing as the input. That means
// every piece of dependent editor state — trim_start_seconds/trim_end_seconds, splits that share
// a source, video/text overlay time anchors, caption cues — stays valid across the swap and needs
// no rewriting. Processing only the visible window would be marginally cheaper but would
// invalidate all of it.
//
// The billing consequence is explicit and intended: a user who trims 5s out of a 60s clip is
// billed for 60s, because 60s is what the provider processes. At 0.42 cr/s that is 26 credits.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { projectClips, projects, videoBackgroundRemovalJobs, type VideoBackgroundRemovalJob } from '../db/schema';
import { redis } from '../redis/client';
import { getGenerationPresignedUrl } from './archivalService';
import { probeDurationSeconds } from './mediaProbe';
import { isBackgroundColor, type BackgroundColor } from './providers/VideoBackgroundRemovalProvider';

export class VideoBgRemovalNotFoundError extends Error {}
export class VideoBgRemovalValidationError extends Error {}
export class InsufficientBgRemovalCreditsError extends Error {}
export class BgRemovalRateLimitedError extends Error {}
export class BgRemovalInProgressError extends Error {}

export interface VideoBgRemovalQuote {
  supported: true;
  duration_seconds: number;
  cost_credits: number;
}

export interface OwnedVideoClip {
  id: string;
  project_id: string;
  r2_key: string;
  media_type: string;
  original_duration_seconds: number | null;
  trim_start_seconds: number;
  trim_end_seconds: number | null;
}

/**
 * Container/codec for a requested background. NEVER client-chosen.
 *
 * ⚠️ Bria's own default is `webm_vp9`, which iOS AVPlayer cannot decode — shipping it would
 * produce jobs that bill correctly and then play as a black rectangle on device. Transparency
 * therefore goes out as `mov_h265` (HEVC with an alpha channel, which iOS plays natively and
 * which composites in Edit Studio); every solid-color background goes out as `mp4_h264`, the
 * most broadly playable option and the right choice for feed export.
 */
export function resolveOutputContainer(backgroundColor: BackgroundColor): string {
  return backgroundColor === 'Transparent' ? 'mov_h265' : 'mp4_h264';
}

/** File extension matching resolveOutputContainer, for the R2 key. */
export function resolveOutputExtension(containerAndCodec: string): string {
  return containerAndCodec.startsWith('mov_') ? 'mov' : 'mp4';
}

export function parseBackgroundColor(value: unknown): BackgroundColor {
  if (value == null) return 'Transparent';
  if (!isBackgroundColor(value)) {
    throw new VideoBgRemovalValidationError('Unsupported background color');
  }
  return value;
}

export function computeBgRemovalCredits(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds * config.videoBgRemovalCreditsPerSecond));
}

/**
 * Ownership-scoped clip lookup (same no-existence-leak contract as audio separation: a clip owned
 * by another user throws NotFound, never 403). Scoping every job to a user-owned, already-paid
 * clip is what stops this becoming a free general-purpose background-removal API.
 */
export async function verifyClipOwnership(clipId: string, userId: string): Promise<OwnedVideoClip> {
  const [row] = await db
    .select({
      id: projectClips.id,
      project_id: projectClips.project_id,
      r2_key: projectClips.r2_key,
      media_type: projectClips.media_type,
      original_duration_seconds: projectClips.original_duration_seconds,
      trim_start_seconds: projectClips.trim_start_seconds,
      trim_end_seconds: projectClips.trim_end_seconds,
    })
    .from(projectClips)
    .innerJoin(projects, eq(projectClips.project_id, projects.id))
    .where(and(
      eq(projectClips.id, clipId),
      eq(projects.user_id, userId),
      isNull(projectClips.deleted_at),
    ));
  if (!row) throw new VideoBgRemovalNotFoundError();
  return row;
}

/**
 * Resolves the clip's VISIBLE (trimmed) duration in explicit seconds — what the user actually
 * sees, what the provider is asked to process, and what they are billed for (CLAUDE.md rule #7 —
 * never bill from a placeholder or a provider-side "auto" duration).
 *
 * Deliberately the trimmed window, NOT the full source. Billing the full source meant a 5-minute
 * upload trimmed to 5 visible seconds cost 126 credits for work the user never sees, and — worse —
 * tripped the max-duration guard below, so long sources were refused outright however short the
 * visible window was. The worker cuts this exact window before dispatching, so quote, charge, and
 * provider input all describe the same span.
 *
 * `original_duration_seconds` is nullable on legacy rows, so a missing trim_end self-heals via
 * ffprobe against a presigned URL and persists the result. A clip whose duration cannot be
 * resolved at all THROWS rather than falling back to an estimate — this is a per-second-billed
 * provider, so an unverifiable duration must block the charge instead of guessing at it.
 */
export async function resolveBillableDuration(clip: OwnedVideoClip): Promise<number> {
  let end = clip.trim_end_seconds ?? clip.original_duration_seconds;

  if (end == null || end <= 0) {
    const probed = await probeDurationSeconds(await getGenerationPresignedUrl(clip.r2_key));
    if (probed != null && probed > 0) {
      end = clip.trim_end_seconds ?? probed;
      await db
        .update(projectClips)
        .set({ original_duration_seconds: probed })
        .where(eq(projectClips.id, clip.id));
    }
  }

  const start = Math.max(0, clip.trim_start_seconds ?? 0);
  const duration = end == null ? null : end - start;

  if (duration == null || duration <= 0) {
    throw new VideoBgRemovalValidationError('clip has no resolvable duration');
  }
  // The cap now bounds the VISIBLE window, so a long source with a short trim is allowed — only
  // an actually-long span of provider work is refused.
  if (duration > config.videoBgRemovalMaxDurationSeconds) {
    throw new VideoBgRemovalValidationError(
      `Clip is too long for background removal (max ${config.videoBgRemovalMaxDurationSeconds}s)`,
    );
  }
  return Math.round(duration * 1000) / 1000;
}

function assertVideoClip(clip: OwnedVideoClip): void {
  if (clip.media_type !== 'video') {
    throw new VideoBgRemovalValidationError('Background removal only applies to video clips');
  }
}

export async function quoteVideoBackgroundRemoval(
  clipId: string,
  userId: string,
): Promise<VideoBgRemovalQuote> {
  const clip = await verifyClipOwnership(clipId, userId);
  assertVideoClip(clip);
  const durationSeconds = await resolveBillableDuration(clip);
  return {
    supported: true,
    duration_seconds: durationSeconds,
    cost_credits: computeBgRemovalCredits(durationSeconds),
  };
}

/**
 * Redis daily per-user rate-limit backstop — generous cap, not the primary abuse guard
 * (ownership-scoping is). Mirrors checkDailyRateLimit in audioSeparationService.
 */
export async function checkDailyRateLimit(userId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `video_bg_rl:${userId}:${day}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 86400);
  if (count > config.videoBgRemovalDailyRateLimitPerUser) throw new BgRemovalRateLimitedError();
}

/**
 * Rejects a second in-flight job for the same clip. Two concurrent jobs would both capture a
 * source_prior_r2_key and both swap project_clips.r2_key, so the loser's captured "prior" would be
 * the winner's OUTPUT — permanently breaking undo back to the original media.
 */
async function assertNoJobInFlight(clipId: string): Promise<void> {
  const [inFlight] = await db
    .select({ id: videoBackgroundRemovalJobs.id })
    .from(videoBackgroundRemovalJobs)
    .where(and(
      eq(videoBackgroundRemovalJobs.source_clip_id, clipId),
      sql`${videoBackgroundRemovalJobs.status} IN ('pending','processing')`,
    ));
  if (inFlight) throw new BgRemovalInProgressError();
}

export async function createVideoBackgroundRemovalJob(input: {
  userId: string;
  clipId: string;
  backgroundColor: BackgroundColor;
  idempotencyKey: string;
}): Promise<{ row: VideoBackgroundRemovalJob; created: boolean }> {
  const clip = await verifyClipOwnership(input.clipId, input.userId);
  assertVideoClip(clip);

  // Idempotency replay must NOT trip the in-flight guard — check for the existing row first.
  const existing = await db
    .select()
    .from(videoBackgroundRemovalJobs)
    .where(and(
      eq(videoBackgroundRemovalJobs.user_id, input.userId),
      eq(videoBackgroundRemovalJobs.idempotency_key, input.idempotencyKey),
    ));
  if (existing[0]) return { row: existing[0], created: false };

  await assertNoJobInFlight(input.clipId);

  const durationSeconds = await resolveBillableDuration(clip);
  const costCredits = computeBgRemovalCredits(durationSeconds);
  const outputContainer = resolveOutputContainer(input.backgroundColor);

  const id = randomUUID();
  try {
    // Single guarded CTE: the balance UPDATE, ledger INSERT, and job-row INSERT all happen in ONE
    // statement (CLAUDE.md rule #1 — `credits_balance >= cost` IS the atomic check; never a
    // separate SELECT then UPDATE). If the WHERE clause matches zero rows (insufficient credits),
    // `deducted` is empty and nothing downstream inserts.
    const result = await db.execute(sql`
      WITH deducted AS (
        UPDATE users
        SET credits_balance = credits_balance - ${costCredits}, updated_at = now()
        WHERE id = ${input.userId}::uuid AND credits_balance >= ${costCredits}
        RETURNING id
      ), ledger AS (
        INSERT INTO credit_transactions (user_id, amount, type, reference_id)
        SELECT id, ${-costCredits}, 'generation_deduct'::credit_transaction_type, ${`video-bg:${id}`}
        FROM deducted
      )
      INSERT INTO video_background_removal_jobs (
        id, user_id, project_id, source_clip_id, idempotency_key, status, provider, model,
        background_color, output_container_and_codec, duration_seconds, cost_credits
      )
      SELECT ${id}::uuid, id, ${clip.project_id}::uuid, ${input.clipId}::uuid,
        ${input.idempotencyKey},
        'pending'::video_bg_removal_status, 'fal', ${config.videoBgRemovalModel},
        ${input.backgroundColor}, ${outputContainer}, ${durationSeconds}, ${costCredits}
      FROM deducted
      RETURNING *
    `);
    const row = result.rows?.[0] as unknown as VideoBackgroundRemovalJob | undefined;
    if (!row) throw new InsufficientBgRemovalCreditsError();
    return { row, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      // Idempotency-key race: another concurrent request already inserted the row — re-select it.
      const [row] = await db
        .select()
        .from(videoBackgroundRemovalJobs)
        .where(and(
          eq(videoBackgroundRemovalJobs.user_id, input.userId),
          eq(videoBackgroundRemovalJobs.idempotency_key, input.idempotencyKey),
        ));
      if (row) return { row, created: false };
    }
    throw error;
  }
}

/** Idempotency lookup used before accepting a potentially large on-device result upload. */
export async function findVideoBackgroundRemovalByIdempotency(
  userId: string,
  idempotencyKey: string,
): Promise<VideoBackgroundRemovalJob | null> {
  const [row] = await db
    .select()
    .from(videoBackgroundRemovalJobs)
    .where(and(
      eq(videoBackgroundRemovalJobs.user_id, userId),
      eq(videoBackgroundRemovalJobs.idempotency_key, idempotencyKey),
    ));
  return row ?? null;
}

/**
 * Persists an Apple Vision result that was processed entirely on the user's device.
 *
 * This path costs zero credits and never touches the provider queue. The clip media swap and
 * completed audit row are one guarded SQL statement, so a concurrent clip mutation cannot leave
 * a completed job pointing at media that was never applied.
 */
export async function applyOnDeviceBackgroundRemoval(input: {
  userId: string;
  clipId: string;
  idempotencyKey: string;
  outputR2Key: string;
}): Promise<{ row: VideoBackgroundRemovalJob; created: boolean }> {
  const existing = await findVideoBackgroundRemovalByIdempotency(
    input.userId,
    input.idempotencyKey,
  );
  if (existing) return { row: existing, created: false };

  const clip = await verifyClipOwnership(input.clipId, input.userId);
  assertVideoClip(clip);
  await assertNoJobInFlight(input.clipId);
  const durationSeconds = await resolveBillableDuration(clip);
  const id = randomUUID();

  try {
    const result = await db.execute(sql`
      WITH swapped AS (
        UPDATE project_clips
        SET r2_key = ${input.outputR2Key}
        WHERE id = ${input.clipId}::uuid
          AND deleted_at IS NULL
          AND r2_key = ${clip.r2_key}
        RETURNING project_id
      )
      INSERT INTO video_background_removal_jobs (
        id, user_id, project_id, source_clip_id, idempotency_key, status, provider, model,
        background_color, output_container_and_codec, duration_seconds, cost_credits,
        output_r2_key, source_prior_r2_key, started_at, completed_at
      )
      SELECT
        ${id}::uuid, ${input.userId}::uuid, project_id, ${input.clipId}::uuid,
        ${input.idempotencyKey}, 'completed'::video_bg_removal_status,
        'apple-vision', 'VNGeneratePersonSegmentationRequest',
        'Transparent', 'mov_h265', ${durationSeconds}, 0,
        ${input.outputR2Key}, ${clip.r2_key}, now(), now()
      FROM swapped
      RETURNING *
    `);
    const row = result.rows?.[0] as unknown as VideoBackgroundRemovalJob | undefined;
    if (!row) {
      throw new VideoBgRemovalValidationError(
        'Clip media changed while background removal was uploading',
      );
    }
    return { row, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findVideoBackgroundRemovalByIdempotency(
        input.userId,
        input.idempotencyKey,
      );
      if (raced) return { row: raced, created: false };
    }
    throw error;
  }
}

/** Idempotent retry-safe transition: returns null on a race so the caller re-fetches and short-circuits. */
export async function markBgRemovalProcessing(id: string): Promise<VideoBackgroundRemovalJob | null> {
  const result = await db.execute(sql`
    UPDATE video_background_removal_jobs
    SET status = 'processing'::video_bg_removal_status, started_at = now()
    WHERE id = ${id}::uuid AND status = 'pending'::video_bg_removal_status
    RETURNING *
  `);
  return (result.rows?.[0] as unknown as VideoBackgroundRemovalJob) ?? null;
}

export async function getBgRemovalJob(id: string): Promise<VideoBackgroundRemovalJob | null> {
  const [row] = await db
    .select()
    .from(videoBackgroundRemovalJobs)
    .where(eq(videoBackgroundRemovalJobs.id, id));
  return row ?? null;
}

/**
 * Swaps the clip's media to the processed object and records the prior key for undo, as ONE
 * batched statement pair.
 *
 * neon-http has no interactive transaction (db.transaction throws "No transactions support in
 * neon-http driver"); this codebase's established substitute is db.batch([...]), which Neon runs
 * as a single server-side Postgres transaction with statements in array order, each seeing prior
 * statements' writes. Order matters: capture MUST read project_clips.r2_key before step 2
 * overwrites it.
 *
 * Capture is idempotent on retry — COALESCE keeps an already-captured source_prior_r2_key rather
 * than overwriting it with this job's own output on a second pass.
 */
export async function applyBackgroundRemovalToClip(input: {
  job: VideoBackgroundRemovalJob;
  outputR2Key: string;
}): Promise<{ sourcePriorR2Key: string | null }> {
  // Capture r2_key AND the trim bounds together: the processed media contains ONLY the visible
  // window, so the swap below rebases the clip to [0, duration]. Undo needs all four values to
  // put the clip back exactly as it was (e.g. a 300s source shown as [120, 130]).
  const captureQuery = db.execute(sql`
    UPDATE video_background_removal_jobs
    SET source_prior_r2_key = COALESCE(
          source_prior_r2_key,
          (SELECT r2_key FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
        ),
        source_prior_trim_start_seconds = COALESCE(
          source_prior_trim_start_seconds,
          (SELECT trim_start_seconds FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
        ),
        source_prior_trim_end_seconds = COALESCE(
          source_prior_trim_end_seconds,
          (SELECT trim_end_seconds FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
        ),
        source_prior_original_duration_seconds = COALESCE(
          source_prior_original_duration_seconds,
          (SELECT original_duration_seconds FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
        )
    WHERE id = ${input.job.id}::uuid
    RETURNING source_prior_r2_key
  `);

  // Rebase to the processed window. The clip's VISIBLE length is unchanged, so its footprint on
  // the project timeline — and therefore every overlay/caption anchor — is identical; only the
  // clip's own source coordinates move.
  const swapMediaQuery = db.execute(sql`
    UPDATE project_clips
    SET r2_key = ${input.outputR2Key},
        trim_start_seconds = 0,
        trim_end_seconds = ${input.job.duration_seconds},
        original_duration_seconds = ${input.job.duration_seconds}
    WHERE id = ${input.job.source_clip_id}::uuid AND deleted_at IS NULL
  `);

  const [captureResult] = await db.batch([captureQuery, swapMediaQuery] as const);

  const captured = (captureResult as unknown as {
    rows?: Array<{ source_prior_r2_key: unknown }>;
  }).rows?.[0]?.source_prior_r2_key;

  return { sourcePriorR2Key: typeof captured === 'string' ? captured : null };
}

export async function completeBgRemoval(input: {
  id: string;
  providerRequestId?: string;
  outputR2Key: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE video_background_removal_jobs
    SET status = 'completed'::video_bg_removal_status,
        provider_request_id = ${input.providerRequestId ?? null},
        output_r2_key = ${input.outputR2Key},
        completed_at = now()
    WHERE id = ${input.id}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function refundBgRemoval(id: string, code: string, reason: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH transitioned AS (
      UPDATE video_background_removal_jobs
      SET status = 'refunded'::video_bg_removal_status,
          failure_code = ${code}, failure_reason = ${reason}, failed_at = now()
      WHERE id = ${id}::uuid AND status IN ('pending', 'processing', 'failed')
      RETURNING user_id, cost_credits
    ), restored AS (
      UPDATE users SET credits_balance = credits_balance + transitioned.cost_credits, updated_at = now()
      FROM transitioned WHERE users.id = transitioned.user_id
      RETURNING users.id, transitioned.cost_credits
    )
    INSERT INTO credit_transactions (user_id, amount, type, reference_id)
    SELECT id, cost_credits, 'generation_refund'::credit_transaction_type, ${`video-bg-refund:${id}`}
    FROM restored
    RETURNING user_id
  `);
  return Boolean(result.rows?.length);
}

/**
 * Undo: restores the clip's original media. Deliberately does NOT refund — the provider work was
 * performed and billed; undo is an editing action, not a failure. The processed object stays in
 * R2, so a client that wants redo can re-apply from the job's output_r2_key without paying again.
 */
export async function undoBackgroundRemoval(
  jobId: string,
  userId: string,
): Promise<{ restoredR2Key: string }> {
  const job = await getBgRemovalJob(jobId);
  if (!job || job.user_id !== userId) throw new VideoBgRemovalNotFoundError();
  if (job.status !== 'completed' || !job.source_prior_r2_key) {
    throw new VideoBgRemovalValidationError('Nothing to undo for this job');
  }

  // Guarded on the CURRENT key being this job's output: if the user has since re-processed or
  // otherwise changed the clip's media, this undo is stale and must not clobber the newer state.
  const result = await db.execute(sql`
    UPDATE project_clips
    SET r2_key = ${job.source_prior_r2_key}${trimRestoreFragment(job)}
    WHERE id = ${job.source_clip_id}::uuid
      AND deleted_at IS NULL
      AND r2_key = ${job.output_r2_key}
    RETURNING r2_key
  `);
  if (!result.rows?.length) {
    throw new VideoBgRemovalValidationError('Clip media has changed since this job — undo is stale');
  }
  return { restoredR2Key: job.source_prior_r2_key };
}

/**
 * Trailing SET fragment that puts the clip's trim bounds back where they were, for jobs that
 * rebased them.
 *
 * Empty for jobs that did NOT rebase: the Apple Vision on-device path processes the whole local
 * file and leaves trim bounds alone, and pre-2026-07-31 Bria jobs predate the capture columns.
 * `source_prior_original_duration_seconds` is the discriminator — only a rebasing job records it.
 * Restoring bounds those jobs never moved would corrupt the clip.
 */
function trimRestoreFragment(job: VideoBackgroundRemovalJob) {
  if (job.source_prior_original_duration_seconds == null) return sql``;
  return sql`,
        trim_start_seconds = ${job.source_prior_trim_start_seconds ?? 0},
        trim_end_seconds = ${job.source_prior_trim_end_seconds},
        original_duration_seconds = ${job.source_prior_original_duration_seconds}`;
}

/** Mirror of trimRestoreFragment: re-applies the processed window's rebased bounds. */
function trimReapplyFragment(job: VideoBackgroundRemovalJob) {
  if (job.source_prior_original_duration_seconds == null) return sql``;
  return sql`,
        trim_start_seconds = 0,
        trim_end_seconds = ${job.duration_seconds},
        original_duration_seconds = ${job.duration_seconds}`;
}

/**
 * Redo: re-applies the already-produced object after a successful undo. No provider call, upload,
 * or credit mutation occurs. The guarded current-key check is the mirror of undo: redo may only
 * replace the exact original object captured by this job, never media changed by a later edit.
 */
export async function redoBackgroundRemoval(
  jobId: string,
  userId: string,
): Promise<{ restoredR2Key: string }> {
  const job = await getBgRemovalJob(jobId);
  if (!job || job.user_id !== userId) throw new VideoBgRemovalNotFoundError();
  if (job.status !== 'completed' || !job.source_prior_r2_key || !job.output_r2_key) {
    throw new VideoBgRemovalValidationError('Nothing to redo for this job');
  }

  const result = await db.execute(sql`
    UPDATE project_clips
    SET r2_key = ${job.output_r2_key}${trimReapplyFragment(job)}
    WHERE id = ${job.source_clip_id}::uuid
      AND deleted_at IS NULL
      AND r2_key = ${job.source_prior_r2_key}
    RETURNING r2_key
  `);
  if (!result.rows?.length) {
    throw new VideoBgRemovalValidationError('Clip media has changed since this job — redo is stale');
  }
  return { restoredR2Key: job.output_r2_key };
}
