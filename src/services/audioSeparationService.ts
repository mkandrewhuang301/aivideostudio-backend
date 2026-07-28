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
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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

/**
 * Project-timeline start of a source clip: sum of visible durations of every earlier clip in the
 * same project (sort_order ascending). Separation stems must land here — not at 0 — so a
 * separation of clip 2 spans clip 2's lane instead of the project head.
 */
export async function resolveSourceClipTimelineOffset(
  projectId: string,
  sourceClipId: string,
): Promise<number> {
  const clips = await db
    .select({
      id: projectClips.id,
      trim_start_seconds: projectClips.trim_start_seconds,
      trim_end_seconds: projectClips.trim_end_seconds,
      original_duration_seconds: projectClips.original_duration_seconds,
    })
    .from(projectClips)
    .where(and(
      eq(projectClips.project_id, projectId),
      isNull(projectClips.deleted_at),
    ))
    .orderBy(asc(projectClips.sort_order), asc(projectClips.created_at));

  const targetIndex = clips.findIndex((clip) => clip.id === sourceClipId);
  if (targetIndex < 0) return 0;

  let offset = 0;
  for (const clip of clips.slice(0, targetIndex)) {
    try {
      offset += resolveClipDurationSeconds(clip);
    } catch {
      // Skip clips with no resolvable duration rather than aborting placement.
    }
  }
  return Math.round(offset * 1000) / 1000;
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
  /** Project-timeline seconds where the source clip begins. Defaults to 0 only as a last resort. */
  startOffsetSeconds?: number;
}

export interface AttachSeparationStemsResult {
  residualClipId: string;
  targetClipId: string;
  sourcePriorVolume: number;
}

/**
 * Attaches the two stems and mutes the source — replace-on-attach semantics (bugfix WP1 Task 1.2):
 * a re-separation of the SAME source clip soft-deletes the prior live stem pair and installs a
 * new one, rather than accumulating stems under one source_clip_id (was: unbounded pairs, only
 * ever a positional-guess UI could partially show — see bug B in the 2026-07-27 bugfix plan).
 *
 * neon-http has no interactive transaction (db.transaction throws "No transactions support in
 * neon-http driver" — see NeonHttpSession#transaction); this codebase's established substitute
 * (assertProjectAudioCapacity / insertProjectAudioClipWithCapacity in projectService.ts) is
 * `db.batch([...])`, which Neon executes as ONE server-side Postgres transaction, statements in
 * array order, each seeing prior statements' writes. All five steps below are batched together so
 * a crash never leaves a partial state (e.g. old pair soft-deleted but new pair not yet inserted).
 *
 * Order within the batch:
 *   1. Capture: writes this job's source_prior_volume. Carry-forward (fixes D — undo-forever-mute
 *      bug): if a live stem pair already exists for this source clip, its OLDEST job's
 *      source_prior_volume is the TRUE original value and is carried forward via a correlated
 *      subquery; project_clips.volume is only read directly when no live stems exist yet (on a
 *      second+ separation, project_clips.volume is already 0 from the first run and would
 *      overwrite the real prior value with 0, permanently breaking undo). This subquery MUST run
 *      before step 2 soft-deletes the old pair, which it does by array position.
 *   2. Soft-delete (never hard — DECISIONS.md §3 recoverable model) any existing live stems for
 *      this source clip.
 *   3/4. Insert residual (enabled=true, "Everything else", sort_order 0) and target/isolated
 *      (enabled=false, the prompt, sort_order 1) — explicit sort_order fixes C2 (GET ordering was
 *      non-deterministic when both stems defaulted to 0). Both carry separation_job_id/role so
 *      the client can group by job instead of guessing positionally (fixes C).
 *   5. MUTE the source: project_clips.volume = 0 — the RESOLVED source-mute mechanism (file header
 *      has the client-facing reverse endpoint / iOS undo contract).
 */
export async function attachSeparationStems(input: AttachSeparationStemsInput): Promise<AttachSeparationStemsResult> {
  const captureQuery = db.execute(sql`
    UPDATE audio_separation_jobs
    SET source_prior_volume = COALESCE(
      (
        SELECT j2.source_prior_volume
        FROM project_audio_clips a2
        JOIN audio_separation_jobs j2 ON j2.id = a2.separation_job_id
        WHERE a2.source_clip_id = ${input.job.source_clip_id}::uuid
          AND a2.source_type = 'separation'
          AND a2.deleted_at IS NULL
        ORDER BY j2.created_at ASC
        LIMIT 1
      ),
      (SELECT volume FROM project_clips WHERE id = ${input.job.source_clip_id}::uuid)
    )
    WHERE id = ${input.job.id}::uuid
    RETURNING source_prior_volume
  `);

  const softDeletePriorStemsQuery = db.execute(sql`
    UPDATE project_audio_clips
    SET deleted_at = now()
    WHERE source_clip_id = ${input.job.source_clip_id}::uuid
      AND source_type = 'separation'
      AND deleted_at IS NULL
  `);

  const startOffsetSeconds = Math.max(0, input.startOffsetSeconds ?? 0);

  const insertResidualQuery = db.insert(projectAudioClips).values({
    project_id: input.job.project_id,
    r2_key: input.residualR2Key,
    source_type: 'separation',
    source_clip_id: input.job.source_clip_id,
    separation_job_id: input.job.id,
    separation_role: 'residual',
    sort_order: 0,
    label: input.residualLabel,
    prompt: input.job.prompt,
    start_offset_seconds: startOffsetSeconds,
    original_duration_seconds: input.job.duration_seconds,
    trim_end_seconds: input.job.duration_seconds,
    enabled: true,
    gain: 1,
  }).returning();

  const insertTargetQuery = db.insert(projectAudioClips).values({
    project_id: input.job.project_id,
    r2_key: input.targetR2Key,
    source_type: 'separation',
    source_clip_id: input.job.source_clip_id,
    separation_job_id: input.job.id,
    separation_role: 'target',
    sort_order: 1,
    label: input.targetLabel,
    prompt: input.job.prompt,
    start_offset_seconds: startOffsetSeconds,
    original_duration_seconds: input.job.duration_seconds,
    trim_end_seconds: input.job.duration_seconds,
    enabled: false,
    gain: 1,
  }).returning();

  const muteSourceQuery = db.execute(sql`
    UPDATE project_clips SET volume = 0 WHERE id = ${input.job.source_clip_id}::uuid
  `);

  const [captureResult, , residualRows, targetRows] = await db.batch([
    captureQuery,
    softDeletePriorStemsQuery,
    insertResidualQuery,
    insertTargetQuery,
    muteSourceQuery,
  ] as const);

  const capturedVolume = (captureResult as unknown as { rows?: Array<{ source_prior_volume: unknown }> }).rows?.[0]?.source_prior_volume;
  const sourcePriorVolume = capturedVolume == null ? 1 : Number(capturedVolume);
  const residualClip = (residualRows as Array<{ id: string }>)[0];
  const targetClip = (targetRows as Array<{ id: string }>)[0];

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
