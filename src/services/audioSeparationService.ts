// src/services/audioSeparationService.ts
// Audio Separation service layer — quote, ownership scoping, atomic credit deduction, refund,
// status transitions, and stem-attachment. This is the money + correctness core (CLAUDE.md rule
// #1: single guarded UPDATE, never SELECT-then-UPDATE; rule #7: duration resolved server-side,
// never '-1'). Closest analog: soundtrackService.ts (quote -> idempotent atomic-deduct create ->
// mark-processing -> complete -> refund -> attach-as-AudioClip).
//
// RESOLVED source-mute mechanism (see 20.1-03-PLAN.md objective): the separation SOURCE is a
// project_clips row. It has a `volume` column (double precision 0..1, default 1) and NO `enabled`
// column. Muting the source = `UPDATE project_clips SET volume = 0 WHERE id = source_clip_id`,
// exposed to clients via `PATCH /api/projects/:projectId/clips/:clipId` with body `{ volume }`
// (src/routes/projects.ts:547). iOS undo (Plan 06) MUST reverse it through this same clip-volume
// path, NOT through updateAudioClip. The clip's PRIOR volume is captured into
// audio_separation_jobs.source_prior_volume BEFORE the mute write so undo restores the exact
// prior value (e.g. 0.7), never a hardcoded 1.0.

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { audioSeparationJobs, projectAudioClips, projectClips, projects, type AudioSeparationJob } from '../db/schema';
import { redis } from '../redis/client';

export class AudioSeparationNotFoundError extends Error {}
export class AudioSeparationValidationError extends Error {}
export class InsufficientSeparationCreditsError extends Error {}
export class SeparationRateLimitedError extends Error {}

export interface AudioSeparationQuote {
  supported: true;
  duration_seconds: number;
  cost_credits: number;
}

export interface OwnedClip {
  id: string;
  project_id: string;
  volume: number;
  trim_start_seconds: number;
  trim_end_seconds: number | null;
  original_duration_seconds: number | null;
}

/**
 * Resolves a clip's exact duration server-side from stored metadata (CLAUDE.md rule #7 — explicit
 * seconds, NEVER '-1'/intelligent duration). A clip with no resolvable duration throws rather than
 * silently returning a placeholder.
 */
export function resolveClipDurationSeconds(
  clip: Pick<OwnedClip, 'trim_start_seconds' | 'trim_end_seconds' | 'original_duration_seconds'>,
): number {
  const end = clip.trim_end_seconds ?? clip.original_duration_seconds;
  const start = clip.trim_start_seconds ?? 0;
  const duration = end == null ? null : Math.max(0, end - start);
  if (duration == null || duration <= 0) {
    throw new AudioSeparationValidationError('clip has no resolvable duration');
  }
  return Math.round(duration * 1000) / 1000;
}

function computeSeparationCredits(durationSeconds: number): number {
  return Math.max(1, Math.ceil(durationSeconds * config.audioSepCreditsPerSecond));
}

/**
 * Ownership-scoped clip lookup (DECISIONS.md §5 input-scoping guard: separation only ever runs on
 * a user-owned, already-paid clip — prevents use as a free general-purpose stem API). A clip owned
 * by another user throws NotFound (no leak of existence). Returns the clip's current `volume` so
 * callers can later capture it before muting (see attachSeparationStems).
 */
export async function verifyClipOwnership(clipId: string, userId: string): Promise<OwnedClip> {
  const [row] = await db
    .select({
      id: projectClips.id,
      project_id: projectClips.project_id,
      volume: projectClips.volume,
      trim_start_seconds: projectClips.trim_start_seconds,
      trim_end_seconds: projectClips.trim_end_seconds,
      original_duration_seconds: projectClips.original_duration_seconds,
    })
    .from(projectClips)
    .innerJoin(projects, eq(projectClips.project_id, projects.id))
    .where(and(
      eq(projectClips.id, clipId),
      eq(projects.user_id, userId),
      isNull(projectClips.deleted_at),
    ));
  if (!row) throw new AudioSeparationNotFoundError();
  return row;
}

export async function quoteAudioSeparation(clipId: string, userId: string): Promise<AudioSeparationQuote> {
  const clip = await verifyClipOwnership(clipId, userId);
  const durationSeconds = resolveClipDurationSeconds(clip);
  return { supported: true, duration_seconds: durationSeconds, cost_credits: computeSeparationCredits(durationSeconds) };
}

/**
 * Redis daily per-user rate-limit backstop (DECISIONS.md §5) — generous cap, not the primary abuse
 * guard (ownership-scoping is). Throws once the (config.audioSepDailyRateLimitPerUser + 1)-th call
 * in a calendar day is made.
 */
export async function checkDailyRateLimit(userId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `audio_sep_rl:${userId}:${day}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 86400);
  if (count > config.audioSepDailyRateLimitPerUser) throw new SeparationRateLimitedError();
}

export async function createAudioSeparationJob(input: {
  userId: string;
  clipId: string;
  prompt: string;
  idempotencyKey: string;
}): Promise<{ row: AudioSeparationJob; created: boolean }> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new AudioSeparationValidationError('A prompt describing the sound to remove is required');
  if (prompt.length > 300) throw new AudioSeparationValidationError('Prompt is too long');

  const clip = await verifyClipOwnership(input.clipId, input.userId);
  const durationSeconds = resolveClipDurationSeconds(clip);
  const costCredits = computeSeparationCredits(durationSeconds);

  const existing = await db
    .select()
    .from(audioSeparationJobs)
    .where(and(
      eq(audioSeparationJobs.user_id, input.userId),
      eq(audioSeparationJobs.idempotency_key, input.idempotencyKey),
    ));
  if (existing[0]) return { row: existing[0], created: false };

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
        SELECT id, ${-costCredits}, 'generation_deduct'::credit_transaction_type, ${`audio-sep:${id}`}
        FROM deducted
      )
      INSERT INTO audio_separation_jobs (
        id, user_id, project_id, source_clip_id, idempotency_key, status, provider, model,
        prompt, duration_seconds, cost_credits
      )
      SELECT ${id}::uuid, id, ${clip.project_id}::uuid, ${input.clipId}::uuid, ${input.idempotencyKey},
        'pending'::audio_separation_status, 'fal', ${config.audioSepModel},
        ${prompt}, ${durationSeconds}, ${costCredits}
      FROM deducted
      RETURNING *
    `);
    const row = result.rows?.[0] as unknown as AudioSeparationJob | undefined;
    if (!row) throw new InsufficientSeparationCreditsError();
    return { row, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      // Idempotency-key race: another concurrent request already inserted the row — re-select it.
      const [row] = await db
        .select()
        .from(audioSeparationJobs)
        .where(and(
          eq(audioSeparationJobs.user_id, input.userId),
          eq(audioSeparationJobs.idempotency_key, input.idempotencyKey),
        ));
      if (row) return { row, created: false };
    }
    throw error;
  }
}

/** Idempotent retry-safe transition: returns null on a race (already processing/terminal) so the caller re-fetches and short-circuits. */
export async function markAudioSeparationProcessing(id: string): Promise<AudioSeparationJob | null> {
  const result = await db.execute(sql`
    UPDATE audio_separation_jobs
    SET status = 'processing'::audio_separation_status, started_at = now()
    WHERE id = ${id}::uuid AND status = 'pending'::audio_separation_status
    RETURNING *
  `);
  return (result.rows?.[0] as unknown as AudioSeparationJob) ?? null;
}

export async function getAudioSeparationJob(id: string): Promise<AudioSeparationJob | null> {
  const [row] = await db.select().from(audioSeparationJobs).where(eq(audioSeparationJobs.id, id));
  return row ?? null;
}

export async function completeAudioSeparation(input: {
  id: string;
  providerRequestId?: string;
  targetR2Key: string;
  residualR2Key: string;
  targetClipId: string;
  residualClipId: string;
}): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE audio_separation_jobs
    SET status = 'completed'::audio_separation_status,
        provider_request_id = ${input.providerRequestId ?? null},
        target_r2_key = ${input.targetR2Key},
        residual_r2_key = ${input.residualR2Key},
        target_audio_clip_id = ${input.targetClipId}::uuid,
        residual_audio_clip_id = ${input.residualClipId}::uuid,
        completed_at = now()
    WHERE id = ${input.id}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export interface AttachSeparationStemsInput {
  job: AudioSeparationJob;
  targetR2Key: string;
  residualR2Key: string;
  residualLabel: string;
  targetLabel: string;
}

export interface AttachSeparationStemsResult {
  residualClipId: string;
  targetClipId: string;
  sourcePriorVolume: number;
}

/**
 * Attaches the two stems and mutes the source, in this exact order:
 *   1. Capture the source clip's CURRENT project_clips.volume into
 *      audio_separation_jobs.source_prior_volume (atomic read+write via a subquery UPDATE — no
 *      separate SELECT-then-UPDATE race). MUST happen before step 3's mute so the pre-mute value
 *      is recorded (DECISIONS.md §3 free-undo — restore the user's exact prior level, not 1.0).
 *   2. Insert TWO project_audio_clips rows: residual (enabled=true, "Everything else") and
 *      target/isolated (enabled=false, the prompt) — a correct partition, never both audible with
 *      the (about to be muted) source (DECISIONS.md §3 DAW mix-invariant).
 *   3. MUTE the source: project_clips.volume = 0. This is the RESOLVED source-mute mechanism — see
 *      the file header for the exact client-facing reverse endpoint (iOS undo contract).
 */
export async function attachSeparationStems(input: AttachSeparationStemsInput): Promise<AttachSeparationStemsResult> {
  const capture = await db.execute(sql`
    UPDATE audio_separation_jobs
    SET source_prior_volume = (SELECT volume FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
    WHERE id = ${input.job.id}::uuid
    RETURNING source_prior_volume
  `);
  const capturedVolume = capture.rows?.[0]?.source_prior_volume;
  const sourcePriorVolume = capturedVolume == null ? 1 : Number(capturedVolume);

  const [residualClip] = await db.insert(projectAudioClips).values({
    project_id: input.job.project_id,
    r2_key: input.residualR2Key,
    source_type: 'separation',
    source_clip_id: input.job.source_clip_id,
    label: input.residualLabel,
    prompt: input.job.prompt,
    original_duration_seconds: input.job.duration_seconds,
    trim_end_seconds: input.job.duration_seconds,
    enabled: true,
    gain: 1,
  }).returning();

  const [targetClip] = await db.insert(projectAudioClips).values({
    project_id: input.job.project_id,
    r2_key: input.targetR2Key,
    source_type: 'separation',
    source_clip_id: input.job.source_clip_id,
    label: input.targetLabel,
    prompt: input.job.prompt,
    original_duration_seconds: input.job.duration_seconds,
    trim_end_seconds: input.job.duration_seconds,
    enabled: false,
    gain: 1,
  }).returning();

  await db.execute(sql`
    UPDATE project_clips SET volume = 0 WHERE id = ${input.job.source_clip_id}::uuid
  `);

  return {
    residualClipId: residualClip.id,
    targetClipId: targetClip.id,
    sourcePriorVolume,
  };
}

export async function refundAudioSeparation(id: string, code: string, reason: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH transitioned AS (
      UPDATE audio_separation_jobs
      SET status = 'refunded'::audio_separation_status,
          failure_code = ${code}, failure_reason = ${reason}, failed_at = now()
      WHERE id = ${id}::uuid AND status IN ('pending', 'processing', 'failed')
      RETURNING user_id, cost_credits
    ), restored AS (
      UPDATE users SET credits_balance = credits_balance + transitioned.cost_credits, updated_at = now()
      FROM transitioned WHERE users.id = transitioned.user_id
      RETURNING users.id, transitioned.cost_credits
    )
    INSERT INTO credit_transactions (user_id, amount, type, reference_id)
    SELECT id, cost_credits, 'generation_refund'::credit_transaction_type, ${`audio-sep-refund:${id}`}
    FROM restored
    RETURNING user_id
  `);
  return Boolean(result.rows?.length);
}
