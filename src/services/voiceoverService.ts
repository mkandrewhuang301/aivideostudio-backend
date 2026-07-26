import { randomUUID } from 'node:crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  projectAudioClips,
  projectVoiceoverGenerations,
  projects,
  type ProjectAudioClip,
  type ProjectVoiceoverGeneration,
} from '../db/schema';
import { getAudioVoiceById } from '../config/audioVoices';
import { quoteVoiceover, VoiceoverQuoteError } from '../config/voiceoverPricing';
import { isPromptFlagged } from '../middleware/promptModeration';
import { getUploadPresignedUrl } from './archivalService';
import { r2, R2_BUCKET } from '../storage/r2';
import { MAX_AUDIO_CLIPS_PER_PROJECT, ProjectAudioCapacityError } from './projectService';

export class VoiceoverNotFoundError extends Error {}
export class VoiceoverValidationError extends Error {}
export class InsufficientVoiceoverCreditsError extends Error {}

export interface VoiceoverQuote {
  voice_id: string;
  script_preview: string;
  cost_credits: number;
  estimated_provider_cents: number;
  pricing_version: string;
}

export async function getVoiceoverQuote(
  projectId: string,
  userId: string,
  voiceId: string,
  script: string,
): Promise<VoiceoverQuote | null> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.user_id, userId)));
  if (!project) return null;

  const trimmed = script.trim();
  if (!voiceId || typeof voiceId !== 'string') {
    throw new VoiceoverValidationError('voice_id is required');
  }
  if (trimmed.length < 1 || trimmed.length > 5000) {
    throw new VoiceoverValidationError('Script must be between 1 and 5000 characters');
  }

  const voice = getAudioVoiceById(voiceId);
  if (!voice) {
    throw new VoiceoverValidationError(`Unknown voice: ${voiceId}`);
  }

  const quote = quoteVoiceover({ voiceId, scriptCharacters: trimmed.length });
  return {
    voice_id: voiceId,
    script_preview: trimmed.slice(0, 120),
    cost_credits: quote.cost_credits,
    estimated_provider_cents: quote.estimated_provider_cents,
    pricing_version: quote.pricing_version,
  };
}

export async function createVoiceoverGeneration(input: {
  projectId: string;
  userId: string;
  idempotencyKey: string;
  voiceId: string;
  script: string;
}): Promise<{ row: ProjectVoiceoverGeneration; created: boolean }> {
  const trimmed = input.script.trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    throw new VoiceoverValidationError('Script must be between 1 and 5000 characters');
  }

  const voice = getAudioVoiceById(input.voiceId);
  if (!voice) {
    throw new VoiceoverValidationError(`Unknown voice: ${input.voiceId}`);
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.user_id, input.userId)));
  if (!project) throw new VoiceoverNotFoundError();

  if (await isPromptFlagged(trimmed)) {
    throw new VoiceoverValidationError('This script violates our content policy');
  }

  const quote = quoteVoiceover({
    voiceId: input.voiceId,
    scriptCharacters: trimmed.length,
  });

  const existing = await db
    .select()
    .from(projectVoiceoverGenerations)
    .where(and(
      eq(projectVoiceoverGenerations.user_id, input.userId),
      eq(projectVoiceoverGenerations.idempotency_key, input.idempotencyKey),
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
        SELECT id, ${-quote.cost_credits}, 'generation_deduct'::credit_transaction_type, ${`voiceover:${id}`}
        FROM deducted
      )
      INSERT INTO project_voiceover_generations (
        id, user_id, project_id, idempotency_key, status,
        voice_id, provider, model, speaker, script,
        pricing_version, estimated_provider_cents, cost_credits
      )
      SELECT ${id}::uuid, id, ${input.projectId}::uuid, ${input.idempotencyKey},
        'pending'::voiceover_generation_status, ${input.voiceId}, ${voice.provider},
        ${voice.model ?? null}, ${voice.speaker ?? null}, ${trimmed},
        ${quote.pricing_version}, ${quote.estimated_provider_cents}, ${quote.cost_credits}
      FROM deducted
      RETURNING *
    `);
    const row = result.rows?.[0] as unknown as ProjectVoiceoverGeneration | undefined;
    if (!row) throw new InsufficientVoiceoverCreditsError();
    return { row, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const [row] = await db
        .select()
        .from(projectVoiceoverGenerations)
        .where(and(
          eq(projectVoiceoverGenerations.user_id, input.userId),
          eq(projectVoiceoverGenerations.idempotency_key, input.idempotencyKey),
        ));
      if (row) return { row, created: false };
    }
    if (error instanceof VoiceoverQuoteError) {
      throw new VoiceoverValidationError(error.message);
    }
    throw error;
  }
}

export async function getVoiceover(
  id: string,
  projectId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(projectVoiceoverGenerations).where(and(
    eq(projectVoiceoverGenerations.id, id),
    eq(projectVoiceoverGenerations.project_id, projectId),
    eq(projectVoiceoverGenerations.user_id, userId),
  ));
  if (!row) return null;
  return publicVoiceover(row);
}


export async function refundVoiceover(id: string, code: string, reason: string): Promise<boolean> {
  const result = await db.execute(sql`
    WITH transitioned AS (
      UPDATE project_voiceover_generations
      SET status = 'refunded'::voiceover_generation_status,
          failure_code = ${code}, failure_reason = ${reason}, failed_at = now(),
          processing_token = null, processing_expires_at = null
      WHERE id = ${id}::uuid AND status IN ('pending', 'processing', 'failed')
      RETURNING user_id, cost_credits
    ), restored AS (
      UPDATE users SET credits_balance = credits_balance + transitioned.cost_credits, updated_at = now()
      FROM transitioned WHERE users.id = transitioned.user_id
      RETURNING users.id, transitioned.cost_credits
    )
    INSERT INTO credit_transactions (user_id, amount, type, reference_id)
    SELECT id, cost_credits, 'generation_refund'::credit_transaction_type, ${`voiceover-refund:${id}`}
    FROM restored
    RETURNING user_id
  `);
  return Boolean(result.rows?.length);
}

export async function getVoiceoverGenerationRow(id: string): Promise<ProjectVoiceoverGeneration | null> {
  const [row] = await db.select().from(projectVoiceoverGenerations).where(eq(projectVoiceoverGenerations.id, id));
  return row ?? null;
}

/**
 * Compare-and-set processing lease. Only `pending` or an expired `processing` lease may transition
 * to the supplied token. Returns the row when the lease is acquired; null otherwise.
 */
export async function markVoiceoverProcessing(
  id: string,
  token: string,
  expiresAt: Date,
): Promise<ProjectVoiceoverGeneration | null> {
  const [row] = await db.update(projectVoiceoverGenerations)
    .set({
      status: 'processing',
      processing_token: token,
      processing_expires_at: expiresAt,
      started_at: new Date(),
    })
    .where(and(
      eq(projectVoiceoverGenerations.id, id),
      or(
        eq(projectVoiceoverGenerations.status, 'pending'),
        and(
          eq(projectVoiceoverGenerations.status, 'processing'),
          sql`${projectVoiceoverGenerations.processing_expires_at} < now()`,
        ),
      ),
    ))
    .returning();
  return row ?? null;
}

export async function saveVoiceoverRaw(
  id: string,
  rawR2Key: string,
  providerRequestId?: string,
): Promise<void> {
  await db.update(projectVoiceoverGenerations).set({
    raw_r2_key: rawR2Key,
    provider_request_id: providerRequestId ?? null,
  }).where(eq(projectVoiceoverGenerations.id, id));
}

/**
 * On a retryable failure, atomically clear the current lease and return the row to pending so the
 * next BullMQ attempt can reacquire it. Increments retry_count so the reaper can eventually give up.
 */
export async function clearVoiceoverLease(id: string, token: string): Promise<void> {
  await db.update(projectVoiceoverGenerations)
    .set({
      status: 'pending',
      processing_token: null,
      processing_expires_at: null,
      retry_count: sql`${projectVoiceoverGenerations.retry_count} + 1`,
    })
    .where(and(
      eq(projectVoiceoverGenerations.id, id),
      eq(projectVoiceoverGenerations.processing_token, token),
    ));
}

/**
 * Completes a voiceover only if the lease token still matches. Returns true when the row was
 * updated, false if the lease was stolen or the row left processing.
 */
export async function completeVoiceover(input: {
  id: string;
  token: string;
  rawR2Key: string;
  finalR2Key: string;
  providerRequestId?: string;
  durationSeconds: number;
  mimeType: string;
}): Promise<boolean> {
  const result = await db.update(projectVoiceoverGenerations)
    .set({
      status: 'succeeded',
      raw_r2_key: input.rawR2Key,
      final_r2_key: input.finalR2Key,
      provider_request_id: input.providerRequestId ?? null,
      duration_seconds: input.durationSeconds,
      mime_type: input.mimeType,
      completed_at: new Date(),
      processing_token: null,
      processing_expires_at: null,
    })
    .where(and(
      eq(projectVoiceoverGenerations.id, input.id),
      eq(projectVoiceoverGenerations.status, 'processing'),
      eq(projectVoiceoverGenerations.processing_token, input.token),
    ))
    .returning({ id: projectVoiceoverGenerations.id });
  return Boolean(result.length);
}

export async function readVoiceoverRaw(key: string): Promise<Buffer> {
  const object = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  if (!object.Body) throw new Error('Voiceover raw source is unavailable');
  return Buffer.from(await object.Body.transformToByteArray());
}

async function publicAudioClip(clip: ProjectAudioClip): Promise<Record<string, unknown>> {
  const url = await getUploadPresignedUrl(clip.r2_key);
  return {
    audio_clip_id: clip.id,
    project_id: clip.project_id,
    source_type: clip.source_type,
    display_name: clip.display_name,
    start_offset_seconds: clip.start_offset_seconds,
    trim_start_seconds: clip.trim_start_seconds,
    trim_end_seconds: clip.trim_end_seconds,
    original_duration_seconds: clip.original_duration_seconds,
    sort_order: clip.sort_order,
    url,
    created_at: clip.created_at,
  };
}

/**
 * Attaches a completed voiceover to its owning project at the requested playhead offset.
 * Idempotent: repeated calls return the same project_audio_clips row. Uses one SQL transaction
 * that locks the voiceover row first, then the project row, then conditionally inserts the clip
 * and updates attached_audio_clip_id. The archived M4A is copied to project-owned R2 before the
 * transaction; on any failure the copied object is removed best-effort.
 */
export async function attachVoiceoverToProject(input: {
  projectId: string;
  voiceoverId: string;
  userId: string;
  startOffsetSeconds: number;
}): Promise<Record<string, unknown> | null> {
  if (!Number.isFinite(input.startOffsetSeconds) || input.startOffsetSeconds < 0) {
    throw new VoiceoverValidationError('start_offset_seconds must be a non-negative finite number');
  }

  const [voiceover] = await db
    .select({
      id: projectVoiceoverGenerations.id,
      final_r2_key: projectVoiceoverGenerations.final_r2_key,
      attached_audio_clip_id: projectVoiceoverGenerations.attached_audio_clip_id,
      duration_seconds: projectVoiceoverGenerations.duration_seconds,
    })
    .from(projectVoiceoverGenerations)
    .where(and(
      eq(projectVoiceoverGenerations.id, input.voiceoverId),
      eq(projectVoiceoverGenerations.project_id, input.projectId),
      eq(projectVoiceoverGenerations.user_id, input.userId),
      eq(projectVoiceoverGenerations.status, 'succeeded'),
    ));

  if (!voiceover?.final_r2_key) return null;

  if (voiceover.attached_audio_clip_id) {
    const [existing] = await db
      .select()
      .from(projectAudioClips)
      .where(eq(projectAudioClips.id, voiceover.attached_audio_clip_id));
    return existing ? publicAudioClip(existing) : null;
  }

  const destinationKey = `projects/${input.projectId}/audio/${randomUUID()}.m4a`;
  try {
    await r2.send(new CopyObjectCommand({
      Bucket: R2_BUCKET,
      CopySource: `${R2_BUCKET}/${voiceover.final_r2_key}`,
      Key: destinationKey,
      ContentType: 'audio/mp4',
    }));
  } catch (error) {
    console.error('[voiceoverService] Failed to copy voiceover to project audio:', error);
    throw new Error('Failed to copy voiceover audio');
  }

  const result = await db.execute(sql`
    WITH voiceover_lock AS (
      SELECT id, attached_audio_clip_id, duration_seconds
      FROM project_voiceover_generations
      WHERE id = ${input.voiceoverId}::uuid
        AND project_id = ${input.projectId}::uuid
        AND user_id = ${input.userId}::uuid
        AND status = 'succeeded'::voiceover_generation_status
        AND final_r2_key IS NOT NULL
      FOR UPDATE
    ),
    project_lock AS (
      SELECT id FROM projects
      WHERE id = ${input.projectId}::uuid AND user_id = ${input.userId}::uuid
      FOR UPDATE
    ),
    clip_count AS (
      SELECT count(*)::int AS cnt
      FROM project_audio_clips
      WHERE project_id = ${input.projectId}::uuid AND deleted_at IS NULL
    ),
    inserted AS (
      INSERT INTO project_audio_clips (
        id, project_id, r2_key, source_type, display_name,
        start_offset_seconds, trim_start_seconds, trim_end_seconds,
        original_duration_seconds, sort_order, deleted_at, created_at
      )
      SELECT
        gen_random_uuid(),
        ${input.projectId}::uuid,
        ${destinationKey},
        'narration',
        'AI Voiceover',
        ${input.startOffsetSeconds},
        0,
        voiceover_lock.duration_seconds,
        voiceover_lock.duration_seconds,
        (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_audio_clips WHERE project_id = ${input.projectId}::uuid AND deleted_at IS NULL),
        null,
        now()
      FROM voiceover_lock, project_lock, clip_count
      WHERE voiceover_lock.attached_audio_clip_id IS NULL
        AND clip_count.cnt < ${MAX_AUDIO_CLIPS_PER_PROJECT}
      RETURNING id
    ),
    updated AS (
      UPDATE project_voiceover_generations
      SET attached_audio_clip_id = inserted.id
      FROM inserted
      WHERE project_voiceover_generations.id = ${input.voiceoverId}::uuid
      RETURNING inserted.id AS audio_clip_id
    )
    SELECT
      (SELECT attached_audio_clip_id FROM voiceover_lock) AS existing_clip_id,
      (SELECT id FROM inserted) AS inserted_clip_id,
      (SELECT audio_clip_id FROM updated) AS updated_clip_id
  `);

  const row = result.rows?.[0] as unknown as {
    existing_clip_id?: string | null;
    inserted_clip_id?: string | null;
    updated_clip_id?: string | null;
  } | undefined;

  if (!row) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey })).catch(() => {});
    return null;
  }

  if (row.existing_clip_id) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey })).catch(() => {});
    const [existing] = await db
      .select()
      .from(projectAudioClips)
      .where(eq(projectAudioClips.id, row.existing_clip_id));
    return existing ? publicAudioClip(existing) : null;
  }

  if (row.inserted_clip_id && row.updated_clip_id) {
    const [clip] = await db
      .select()
      .from(projectAudioClips)
      .where(eq(projectAudioClips.id, row.inserted_clip_id));
    return clip ? publicAudioClip(clip) : null;
  }

  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: destinationKey })).catch(() => {});
  throw new ProjectAudioCapacityError();
}

async function publicVoiceover(row: ProjectVoiceoverGeneration): Promise<Record<string, unknown>> {
  const audioUrl = row.status === 'succeeded' && row.final_r2_key
    ? await getUploadPresignedUrl(row.final_r2_key)
    : undefined;
  return {
    voiceover_id: row.id,
    project_id: row.project_id,
    status: row.status,
    voice_id: row.voice_id,
    script_preview: row.script.slice(0, 120),
    duration_seconds: row.duration_seconds,
    audio_url: audioUrl,
    cost_credits: row.cost_credits,
    credits_refunded: row.status === 'refunded',
    failure_code: row.failure_code,
    created_at: row.created_at,
  };
}
