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
  r2_key: string;
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

// ─── Separation sources (chaining) ────────────────────────────────────────────
//
// A separation runs on EITHER a project_clips row (depth 1 — the original video clip) or a
// project_audio_clips row (a stem, any depth). Both stems of a pair are separable, so stems form
// a tree. The provider step is already audio-only (the worker's ffmpeg pass strips video to mp3
// before anything reaches fal), so a stem source needs no new provider handling — only different
// bookkeeping: where the stems sit on the timeline, what "silence the source" means, and what
// undo has to restore.

// Separating an audio track CONSUMES it: the track is replaced by the two tracks it decomposes
// into, so the live set stays flat at every depth and no parent/child pair is ever audible at
// once. Separating a video clip instead mutes that clip's own audio and adds two tracks, since a
// clip can't be consumed. parent_audio_clip_id / separation_depth are therefore provenance (for
// undo and debugging), not structure the UI has to render.

export type SeparationSourceKind = 'clip' | 'audio_clip';

/**
 * What job CREATION needs to know about a source: who owns it, which project it belongs to, and
 * how long it is (for pricing). Deliberately excludes the r2 key and timeline offset — those are
 * execution-time concerns resolved by the worker, and fetching them here would cost an extra
 * round-trip on every quote/create.
 */
export interface SeparationSource {
  kind: SeparationSourceKind;
  id: string;
  projectId: string;
  durationSeconds: number;
}

/**
 * Ownership-scoped audio-clip lookup — the stem-source twin of verifyClipOwnership, with the same
 * no-existence-leak contract (a foreign or soft-deleted row throws NotFound, never 403).
 */
export async function verifyAudioClipOwnership(audioClipId: string, userId: string): Promise<{
  id: string;
  project_id: string;
  r2_key: string;
  enabled: boolean;
  gain: number;
  start_offset_seconds: number;
  separation_depth: number;
  source_clip_id: string | null;
  trim_start_seconds: number;
  trim_end_seconds: number | null;
  original_duration_seconds: number | null;
}> {
  const [row] = await db
    .select({
      id: projectAudioClips.id,
      project_id: projectAudioClips.project_id,
      r2_key: projectAudioClips.r2_key,
      enabled: projectAudioClips.enabled,
      gain: projectAudioClips.gain,
      start_offset_seconds: projectAudioClips.start_offset_seconds,
      separation_depth: projectAudioClips.separation_depth,
      source_clip_id: projectAudioClips.source_clip_id,
      trim_start_seconds: projectAudioClips.trim_start_seconds,
      trim_end_seconds: projectAudioClips.trim_end_seconds,
      original_duration_seconds: projectAudioClips.original_duration_seconds,
    })
    .from(projectAudioClips)
    .innerJoin(projects, eq(projectAudioClips.project_id, projects.id))
    .where(and(
      eq(projectAudioClips.id, audioClipId),
      eq(projects.user_id, userId),
      isNull(projectAudioClips.deleted_at),
    ));
  if (!row) throw new AudioSeparationNotFoundError();
  return row;
}

/**
 * Normalizes either source kind into the single descriptor the rest of the pipeline consumes.
 * Exactly one of clipId / audioClipId must be supplied (mirrors the DB's
 * audio_sep_jobs_one_source_chk).
 */
export async function resolveSeparationSource(
  input: { clipId?: string; audioClipId?: string },
  userId: string,
): Promise<SeparationSource> {
  const { clipId, audioClipId } = input;
  if ((clipId == null) === (audioClipId == null)) {
    throw new AudioSeparationValidationError('Provide exactly one of clipId or audioClipId');
  }

  if (clipId != null) {
    const clip = await verifyClipOwnership(clipId, userId);
    return {
      kind: 'clip',
      id: clip.id,
      projectId: clip.project_id,
      durationSeconds: resolveClipDurationSeconds(clip),
    };
  }

  const audio = await verifyAudioClipOwnership(audioClipId as string, userId);
  return {
    kind: 'audio_clip',
    id: audio.id,
    projectId: audio.project_id,
    // project_audio_clips uses the same trim/original-duration field names as project_clips, so
    // the existing resolver applies unchanged.
    durationSeconds: resolveClipDurationSeconds(audio),
  };
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
      r2_key: projectClips.r2_key,
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

/** Quote for separating an existing stem (chaining). Same per-second pricing as a clip source. */
export async function quoteAudioClipSeparation(audioClipId: string, userId: string): Promise<AudioSeparationQuote> {
  const audio = await verifyAudioClipOwnership(audioClipId, userId);
  const durationSeconds = resolveClipDurationSeconds(audio);
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
  /** Depth-1 source: the video clip. Mutually exclusive with audioClipId. */
  clipId?: string;
  /** Chained source: an existing stem (either role, any depth). */
  audioClipId?: string;
  prompt: string;
  idempotencyKey: string;
}): Promise<{ row: AudioSeparationJob; created: boolean }> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new AudioSeparationValidationError('A prompt describing the sound to remove is required');
  if (prompt.length > 300) throw new AudioSeparationValidationError('Prompt is too long');

  const source = await resolveSeparationSource(
    { clipId: input.clipId, audioClipId: input.audioClipId },
    input.userId,
  );
  const durationSeconds = source.durationSeconds;
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
        id, user_id, project_id, source_clip_id, source_audio_clip_id, idempotency_key, status,
        provider, model, prompt, duration_seconds, cost_credits
      )
      SELECT ${id}::uuid, id, ${source.projectId}::uuid,
        ${source.kind === 'clip' ? source.id : null}::uuid,
        ${source.kind === 'audio_clip' ? source.id : null}::uuid,
        ${input.idempotencyKey},
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
  /** Depth of the SOURCE; the produced stems are stored at sourceDepth + 1. Clip sources are 0. */
  sourceDepth?: number;
  /** Root clip provenance carried onto both stems. Defaults to the job's own source_clip_id. */
  rootClipId?: string | null;
}

export interface AttachSeparationStemsResult {
  residualClipId: string;
  targetClipId: string;
  /** Clip-sourced jobs only; 1 when nothing was captured. */
  sourcePriorVolume: number;
  /** Audio-sourced jobs only — the source stem's pre-separation enabled/gain, for undo. */
  sourcePriorEnabled?: boolean;
  sourcePriorGain?: number;
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
  // Chaining: a job sourced from a stem replaces the clip-specific capture/mute steps with their
  // audio-row equivalents. Everything else (batch shape, replace-on-attach, stem partition) is
  // identical, so the two paths share buildStemInsertQueries.
  return input.job.source_audio_clip_id
    ? attachStemsFromAudioClip(input, input.job.source_audio_clip_id)
    : attachStemsFromClip(input);
}

/**
 * Builds the two stem INSERTs shared by both source kinds. `parentAudioClipId` is null at depth 1
 * (separated straight from a clip); `rootClipId` is the originating clip, carried at every depth.
 */
function buildStemInsertQueries(
  input: AttachSeparationStemsInput,
  tree: { parentAudioClipId: string | null; rootClipId: string | null; depth: number },
) {
  const startOffsetSeconds = Math.max(0, input.startOffsetSeconds ?? 0);
  const common = {
    project_id: input.job.project_id,
    source_type: 'separation' as const,
    source_clip_id: tree.rootClipId,
    parent_audio_clip_id: tree.parentAudioClipId,
    separation_depth: tree.depth,
    separation_job_id: input.job.id,
    prompt: input.job.prompt,
    start_offset_seconds: startOffsetSeconds,
    original_duration_seconds: input.job.duration_seconds,
    trim_end_seconds: input.job.duration_seconds,
    gain: 1,
  };

  return [
    db.insert(projectAudioClips).values({
      ...common,
      r2_key: input.residualR2Key,
      separation_role: 'residual',
      sort_order: 0,
      label: input.residualLabel,
      enabled: true,
    }).returning(),
    db.insert(projectAudioClips).values({
      ...common,
      r2_key: input.targetR2Key,
      separation_role: 'target',
      sort_order: 1,
      label: input.targetLabel,
      enabled: false,
    }).returning(),
  ] as const;
}

/**
 * Audio-sourced attach: separating a TRACK replaces it with the two tracks it decomposes into.
 *
 * The result is a flat list, not a tree — the source is consumed, so a parent and its children
 * never coexist. Separating one of the results again does the same thing to it, at any depth,
 * with no special handling: there is nothing to nest and nothing to double-count.
 *
 * Differences from the clip path (a clip can't be consumed — it still has picture — so that path
 * mutes the clip's audio and leaves the clip in place):
 *   1. Capture records the source track's prior enabled/gain rather than a clip volume, so undo
 *      restores the exact prior mix state.
 *   2. Prior live stems are scoped by parent_audio_clip_id — a no-op in normal use (a consumed
 *      source can't be separated twice), kept as a retry guard so re-running is idempotent.
 *   5. The source is SOFT-DELETED rather than muted. Undo restores it and drops the two children.
 */
async function attachStemsFromAudioClip(
  input: AttachSeparationStemsInput,
  sourceAudioClipId: string,
): Promise<AttachSeparationStemsResult> {
  const captureQuery = db.execute(sql`
    UPDATE audio_separation_jobs
    SET source_prior_enabled = COALESCE(
          (
            SELECT j2.source_prior_enabled
            FROM project_audio_clips a2
            JOIN audio_separation_jobs j2 ON j2.id = a2.separation_job_id
            WHERE a2.parent_audio_clip_id = ${sourceAudioClipId}::uuid
              AND a2.source_type = 'separation'
              AND a2.deleted_at IS NULL
            ORDER BY j2.created_at ASC
            LIMIT 1
          ),
          (SELECT enabled FROM project_audio_clips WHERE id = ${sourceAudioClipId}::uuid)
        ),
        source_prior_gain = COALESCE(
          (
            SELECT j2.source_prior_gain
            FROM project_audio_clips a2
            JOIN audio_separation_jobs j2 ON j2.id = a2.separation_job_id
            WHERE a2.parent_audio_clip_id = ${sourceAudioClipId}::uuid
              AND a2.source_type = 'separation'
              AND a2.deleted_at IS NULL
            ORDER BY j2.created_at ASC
            LIMIT 1
          ),
          (SELECT gain FROM project_audio_clips WHERE id = ${sourceAudioClipId}::uuid)
        )
    WHERE id = ${input.job.id}::uuid
    RETURNING source_prior_enabled, source_prior_gain
  `);

  const softDeletePriorStemsQuery = db.execute(sql`
    UPDATE project_audio_clips
    SET deleted_at = now()
    WHERE parent_audio_clip_id = ${sourceAudioClipId}::uuid
      AND source_type = 'separation'
      AND deleted_at IS NULL
  `);

  const [insertResidualQuery, insertTargetQuery] = buildStemInsertQueries(input, {
    parentAudioClipId: sourceAudioClipId,
    rootClipId: input.rootClipId ?? null,
    depth: (input.sourceDepth ?? 0) + 1,
  });

  // CONSUME the source: separating a track replaces it with the two tracks that came out of it,
  // so the source stops existing rather than lingering disabled. Soft-delete (never hard —
  // DECISIONS.md §3) so undo can restore it and drop the two children.
  //
  // This is what keeps the model flat: a parent and its children never coexist, so nothing can
  // double-count in the mix (the mix is the sum of enabled rows) and there is no tree to render.
  const consumeSourceQuery = db.execute(sql`
    UPDATE project_audio_clips SET deleted_at = now()
    WHERE id = ${sourceAudioClipId}::uuid AND deleted_at IS NULL
  `);

  const [captureResult, , residualRows, targetRows] = await db.batch([
    captureQuery,
    softDeletePriorStemsQuery,
    insertResidualQuery,
    insertTargetQuery,
    consumeSourceQuery,
  ] as const);

  const captured = (captureResult as unknown as {
    rows?: Array<{ source_prior_enabled: unknown; source_prior_gain: unknown }>;
  }).rows?.[0];

  return {
    residualClipId: (residualRows as Array<{ id: string }>)[0].id,
    targetClipId: (targetRows as Array<{ id: string }>)[0].id,
    // Not meaningful for an audio source; kept so the result shape stays uniform.
    sourcePriorVolume: 1,
    sourcePriorEnabled: captured?.source_prior_enabled == null ? true : Boolean(captured.source_prior_enabled),
    sourcePriorGain: captured?.source_prior_gain == null ? 1 : Number(captured.source_prior_gain),
  };
}

async function attachStemsFromClip(input: AttachSeparationStemsInput): Promise<AttachSeparationStemsResult> {
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

  const [insertResidualQuery, insertTargetQuery] = buildStemInsertQueries(input, {
    parentAudioClipId: null, // depth 1 — separated straight from the clip
    rootClipId: input.job.source_clip_id,
    depth: 1,
  });

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
