import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
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
          failure_code = ${code}, failure_reason = ${reason}, failed_at = now()
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
