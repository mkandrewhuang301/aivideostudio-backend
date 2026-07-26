import { randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  projectVoiceoverGenerations,
  projects,
  type ProjectVoiceoverGeneration,
} from '../db/schema';
import { getAudioVoiceById } from '../config/audioVoices';
import { quoteVoiceover, VoiceoverQuoteError } from '../config/voiceoverPricing';
import { isPromptFlagged } from '../middleware/promptModeration';
import { getUploadPresignedUrl } from './archivalService';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2, R2_BUCKET } from '../storage/r2';

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
