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

import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { projectClips, projects } from '../db/schema';
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
 * callers can later capture it before muting (see attachSeparationStems, Task 2).
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
