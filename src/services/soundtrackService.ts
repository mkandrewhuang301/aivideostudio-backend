import { createHash, randomUUID } from 'node:crypto';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import {
  projectAudioClips,
  projectClips,
  projects,
  projectSoundtrackGenerations,
  type ProjectSoundtrackGeneration,
} from '../db/schema';
import { getUploadPresignedUrl } from './archivalService';
import { r2, R2_BUCKET } from '../storage/r2';

export type SoundMode = 'instrumental' | 'vocals';

export interface SoundtrackClipSnapshot {
  id: string;
  type: string;
  sort_order: number;
  timeline_start: number;
  timeline_end: number;
  trim_start: number;
  trim_end: number;
  r2_key: string;
}

export interface SoundtrackProjectSnapshot {
  version: 1;
  duration_seconds: number;
  title: string;
  clips: SoundtrackClipSnapshot[];
}

export interface SoundtrackQuote {
  supported: boolean;
  project_duration_seconds: number;
  maximum_duration_seconds?: number;
  model_tier?: 'clip' | 'pro';
  model?: string;
  cost_credits?: number;
  reason?: 'duration_too_long' | 'no_visual_clips';
  message?: string;
}

export class SoundtrackNotFoundError extends Error {}
export class SoundtrackValidationError extends Error {}
export class InsufficientSoundtrackCreditsError extends Error {}

export function quoteSoundtrack(durationSeconds: number, hasVisualClips = true): SoundtrackQuote {
  const rounded = Math.round(durationSeconds * 1000) / 1000;
  if (!hasVisualClips || rounded <= 0) {
    return {
      supported: false,
      project_duration_seconds: rounded,
      reason: 'no_visual_clips',
      message: 'Add a photo or video before creating AI Music.',
    };
  }
  if (rounded > config.aiMusicMaxDurationSeconds) {
    return {
      supported: false,
      project_duration_seconds: rounded,
      maximum_duration_seconds: config.aiMusicMaxDurationSeconds,
      reason: 'duration_too_long',
      message: 'This video is too long for AI Music. AI soundtracks currently support videos up to 3:04. Shorten your video, choose Music, or import audio.',
    };
  }
  const isClip = rounded <= 30;
  return {
    supported: true,
    project_duration_seconds: rounded,
    model_tier: isClip ? 'clip' : 'pro',
    model: isClip ? config.aiMusicClipModel : config.aiMusicProModel,
    cost_credits: isClip ? 4 : 8,
  };
}

export function fingerprintSnapshot(snapshot: SoundtrackProjectSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function buildSoundtrackSnapshot(
  projectId: string,
  userId: string,
): Promise<{ snapshot: SoundtrackProjectSnapshot; fingerprint: string } | null> {
  const [project] = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!project) return null;

  const clips = await db
    .select({
      id: projectClips.id,
      type: projectClips.media_type,
      sortOrder: projectClips.sort_order,
      r2Key: projectClips.r2_key,
      trimStart: projectClips.trim_start_seconds,
      trimEnd: projectClips.trim_end_seconds,
      originalDuration: projectClips.original_duration_seconds,
    })
    .from(projectClips)
    .where(and(eq(projectClips.project_id, projectId), isNull(projectClips.deleted_at)))
    .orderBy(projectClips.sort_order);

  let cursor = 0;
  const snapshotClips: SoundtrackClipSnapshot[] = [];
  for (const clip of clips) {
    const fallbackEnd = clip.type === 'image' ? clip.trimStart + 3 : clip.originalDuration;
    const trimEnd = clip.trimEnd ?? fallbackEnd;
    if (trimEnd == null || trimEnd <= clip.trimStart) {
      throw new SoundtrackValidationError('A project clip has no usable duration');
    }
    const duration = trimEnd - clip.trimStart;
    snapshotClips.push({
      id: clip.id,
      type: clip.type,
      sort_order: clip.sortOrder,
      timeline_start: cursor,
      timeline_end: cursor + duration,
      trim_start: clip.trimStart,
      trim_end: trimEnd,
      r2_key: clip.r2Key,
    });
    cursor += duration;
  }
  const snapshot: SoundtrackProjectSnapshot = {
    version: 1,
    duration_seconds: Math.round(cursor * 1000) / 1000,
    title: project.title?.trim() || 'Untitled Project',
    clips: snapshotClips,
  };
  return { snapshot, fingerprint: fingerprintSnapshot(snapshot) };
}

export async function getSoundtrackQuote(projectId: string, userId: string): Promise<SoundtrackQuote | null> {
  const built = await buildSoundtrackSnapshot(projectId, userId);
  if (!built) return null;
  return quoteSoundtrack(built.snapshot.duration_seconds, built.snapshot.clips.length > 0);
}

export async function createSoundtrackGeneration(input: {
  projectId: string;
  userId: string;
  idempotencyKey: string;
  soundMode: SoundMode;
  direction?: string | null;
}): Promise<{ row: ProjectSoundtrackGeneration; created: boolean }> {
  const direction = input.direction?.trim() || null;
  if (direction && direction.length > 300) throw new SoundtrackValidationError('Music description is too long');
  const built = await buildSoundtrackSnapshot(input.projectId, input.userId);
  if (!built) throw new SoundtrackNotFoundError();
  const quote = quoteSoundtrack(built.snapshot.duration_seconds, built.snapshot.clips.length > 0);
  if (!quote.supported || !quote.model || !quote.cost_credits) {
    throw new SoundtrackValidationError(quote.message ?? 'AI Music is unavailable for this project');
  }

  const existing = await db
    .select()
    .from(projectSoundtrackGenerations)
    .where(and(
      eq(projectSoundtrackGenerations.user_id, input.userId),
      eq(projectSoundtrackGenerations.idempotency_key, input.idempotencyKey),
    ));
  if (existing[0]) return { row: existing[0], created: false };

  const id = randomUUID();
  try {
    const result = await db.execute(sql`
      WITH deducted AS (
        UPDATE users
        SET credits_balance = credits_balance - ${quote.cost_credits}, updated_at = now()
        WHERE id = ${input.userId}::uuid AND credits_balance >= ${quote.cost_credits}
        RETURNING id
      ), ledger AS (
        INSERT INTO credit_transactions (user_id, amount, type, reference_id)
        SELECT id, ${-quote.cost_credits}, 'generation_deduct'::credit_transaction_type, ${`soundtrack:${id}`}
        FROM deducted
      )
      INSERT INTO project_soundtrack_generations (
        id, user_id, project_id, idempotency_key, status, provider, model, sound_mode,
        direction, project_duration_seconds, project_snapshot, project_fingerprint, cost_credits
      )
      SELECT ${id}::uuid, id, ${input.projectId}::uuid, ${input.idempotencyKey},
        'pending'::soundtrack_generation_status, ${config.aiMusicProvider}, ${quote.model},
        ${input.soundMode}, ${direction}, ${quote.project_duration_seconds},
        ${JSON.stringify(built.snapshot)}::jsonb, ${built.fingerprint}, ${quote.cost_credits}
      FROM deducted
      RETURNING *
    `);
    const row = result.rows?.[0] as unknown as ProjectSoundtrackGeneration | undefined;
    if (!row) throw new InsufficientSoundtrackCreditsError();
    return { row, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const [row] = await db
        .select()
        .from(projectSoundtrackGenerations)
        .where(and(
          eq(projectSoundtrackGenerations.user_id, input.userId),
          eq(projectSoundtrackGenerations.idempotency_key, input.idempotencyKey),
        ));
      if (row) return { row, created: false };
    }
    throw error;
  }
}

export async function markSoundtrackProcessing(id: string): Promise<ProjectSoundtrackGeneration | null> {
  const [row] = await db
    .update(projectSoundtrackGenerations)
    .set({ status: 'processing', started_at: new Date() })
    .where(and(eq(projectSoundtrackGenerations.id, id), eq(projectSoundtrackGenerations.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function getSoundtrackGenerationRow(id: string): Promise<ProjectSoundtrackGeneration | null> {
  const [row] = await db.select().from(projectSoundtrackGenerations).where(eq(projectSoundtrackGenerations.id, id));
  return row ?? null;
}

export async function saveSoundtrackRaw(
  id: string,
  rawR2Key: string,
  providerRequestId?: string,
): Promise<void> {
  await db.update(projectSoundtrackGenerations).set({
    raw_r2_key: rawR2Key,
    provider_request_id: providerRequestId ?? null,
  }).where(eq(projectSoundtrackGenerations.id, id));
}

export async function completeSoundtrack(input: {
  id: string;
  rawR2Key: string;
  finalR2Key: string;
  providerRequestId?: string;
  displayName: string;
}): Promise<void> {
  await db.update(projectSoundtrackGenerations).set({
    status: 'completed',
    raw_r2_key: input.rawR2Key,
    final_r2_key: input.finalR2Key,
    provider_request_id: input.providerRequestId ?? null,
    mime_type: 'audio/mp4',
    display_name: input.displayName,
    completed_at: new Date(),
  }).where(and(
    eq(projectSoundtrackGenerations.id, input.id),
    eq(projectSoundtrackGenerations.status, 'processing'),
  ));
}

export async function refundSoundtrack(id: string, code: string, reason: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH transitioned AS (
      UPDATE project_soundtrack_generations
      SET status = 'refunded'::soundtrack_generation_status,
          failure_code = ${code}, failure_reason = ${reason}, failed_at = now()
      WHERE id = ${id}::uuid AND status IN ('pending', 'processing', 'failed')
      RETURNING user_id, cost_credits
    ), restored AS (
      UPDATE users SET credits_balance = credits_balance + transitioned.cost_credits, updated_at = now()
      FROM transitioned WHERE users.id = transitioned.user_id
      RETURNING users.id, transitioned.cost_credits
    )
    INSERT INTO credit_transactions (user_id, amount, type, reference_id)
    SELECT id, cost_credits, 'generation_refund'::credit_transaction_type, ${`soundtrack-refund:${id}`}
    FROM restored
    RETURNING user_id
  `);
  return Boolean(result.rows?.length);
}

function publicSoundtrack(row: ProjectSoundtrackGeneration, previewUrl?: string) {
  const snapshot = row.project_snapshot as Partial<SoundtrackProjectSnapshot>;
  return {
    soundtrack_id: row.id,
    project_id: row.project_id,
    status: row.status,
    title: row.display_name ?? 'Untitled soundtrack',
    origin_project_title: snapshot.title ?? 'Untitled Project',
    duration_seconds: row.project_duration_seconds,
    sound_mode: row.sound_mode,
    preview_url: previewUrl,
    cost_credits: row.cost_credits,
    failure_code: row.failure_code,
    credits_refunded: row.status === 'refunded',
    created_at: row.created_at,
  };
}

export async function getSoundtrack(id: string, projectId: string, userId: string) {
  const [row] = await db.select().from(projectSoundtrackGenerations).where(and(
    eq(projectSoundtrackGenerations.id, id),
    eq(projectSoundtrackGenerations.project_id, projectId),
    eq(projectSoundtrackGenerations.user_id, userId),
  ));
  if (!row) return null;
  const preview = row.status === 'completed' && row.final_r2_key
    ? await getUploadPresignedUrl(row.final_r2_key)
    : undefined;
  return publicSoundtrack(row, preview);
}

export async function listSoundtracks(userId: string) {
  const rows = await db.select().from(projectSoundtrackGenerations).where(and(
    eq(projectSoundtrackGenerations.user_id, userId),
    eq(projectSoundtrackGenerations.status, 'completed'),
    isNull(projectSoundtrackGenerations.library_deleted_at),
  )).orderBy(desc(projectSoundtrackGenerations.created_at));
  return Promise.all(rows.map(async (row) => publicSoundtrack(
    row,
    row.final_r2_key ? await getUploadPresignedUrl(row.final_r2_key) : undefined,
  )));
}

export async function renameSoundtrack(id: string, userId: string, name: string) {
  const displayName = name.trim();
  if (!displayName || displayName.length > 80) throw new SoundtrackValidationError('Invalid soundtrack name');
  const [row] = await db.update(projectSoundtrackGenerations).set({ display_name: displayName }).where(and(
    eq(projectSoundtrackGenerations.id, id),
    eq(projectSoundtrackGenerations.user_id, userId),
    isNull(projectSoundtrackGenerations.library_deleted_at),
  )).returning();
  return row ? publicSoundtrack(row) : null;
}

export async function deleteSoundtrackFromLibrary(id: string, userId: string): Promise<boolean> {
  const [row] = await db.update(projectSoundtrackGenerations)
    .set({ library_deleted_at: new Date() })
    .where(and(
      eq(projectSoundtrackGenerations.id, id),
      eq(projectSoundtrackGenerations.user_id, userId),
      isNull(projectSoundtrackGenerations.library_deleted_at),
    ))
    .returning({ id: projectSoundtrackGenerations.id });
  return Boolean(row);
}

export async function attachSoundtrack(targetProjectId: string, soundtrackId: string, userId: string) {
  const [ownedProject] = await db.select({ id: projects.id }).from(projects).where(and(
    eq(projects.id, targetProjectId), eq(projects.user_id, userId),
  ));
  if (!ownedProject) return null;
  const [soundtrack] = await db.select().from(projectSoundtrackGenerations).where(and(
    eq(projectSoundtrackGenerations.id, soundtrackId),
    eq(projectSoundtrackGenerations.user_id, userId),
    eq(projectSoundtrackGenerations.status, 'completed'),
  ));
  if (!soundtrack?.final_r2_key) return null;
  const [existing] = await db.select().from(projectAudioClips).where(and(
    eq(projectAudioClips.project_id, targetProjectId),
    eq(projectAudioClips.source_soundtrack_id, soundtrack.id),
    isNull(projectAudioClips.deleted_at),
  ));
  if (existing) return existing;

  const destination = `projects/${targetProjectId}/audio/${randomUUID()}.m4a`;
  await r2.send(new CopyObjectCommand({
    Bucket: R2_BUCKET,
    CopySource: `${R2_BUCKET}/${soundtrack.final_r2_key}`,
    Key: destination,
  }));
  const orderResult = await db.execute(sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
    FROM project_audio_clips WHERE project_id = ${targetProjectId}::uuid AND deleted_at IS NULL
  `);
  const sortOrder = Number(orderResult.rows?.[0]?.next_order ?? 0);
  const [clip] = await db.insert(projectAudioClips).values({
    project_id: targetProjectId,
    r2_key: destination,
    source_type: 'ai',
    display_name: soundtrack.display_name,
    source_soundtrack_id: soundtrack.id,
    start_offset_seconds: 0,
    trim_start_seconds: 0,
    trim_end_seconds: soundtrack.project_duration_seconds,
    original_duration_seconds: soundtrack.project_duration_seconds,
    sort_order: sortOrder,
  }).returning();
  if (soundtrack.project_id === targetProjectId) {
    await db.update(projectSoundtrackGenerations)
      .set({ attached_audio_clip_id: clip.id })
      .where(and(
        eq(projectSoundtrackGenerations.id, soundtrack.id),
        isNull(projectSoundtrackGenerations.attached_audio_clip_id),
      ));
  }
  return clip;
}
