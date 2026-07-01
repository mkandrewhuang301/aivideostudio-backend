// src/services/generationService.ts
// Generation orchestration: duration resolution, cost calculation, row CRUD, atomic status transitions.
// CLAUDE.md Rule 1: status transitions use the same atomic UPDATE...WHERE...RETURNING guard as creditService.
// CLAUDE.md Rule 7: resolveDurationSeconds NEVER returns -1; resolved before credit deduction or dispatch.

import { db } from '../db/client';
import { generations } from '../db/schema';
import { sql, desc, lt, eq, and, notInArray, or } from 'drizzle-orm';
import type { GenerationStatus, NewGeneration } from '../db/schema';

export const CREDITS_PER_DOLLAR = 50; // mirrors SUBSCRIPTION_CREDITS/TOPUP_CREDITS scale in revenuecat.ts (500 credits ≈ $9.99)

export const MODEL_RATES: Record<string, { nonVideoIn: Record<string, number>; videoIn: Record<string, number> }> = {
  'bytedance/seedance-2.0-fast': {
    nonVideoIn: { '480p': 0.07, '720p': 0.15 },
    videoIn:    { '480p': 0.08, '720p': 0.17 },
  },
  'bytedance/seedance-2.0-mini': {
    nonVideoIn: { '480p': 0.04, '720p': 0.09 },
    videoIn:    { '480p': 0.05, '720p': 0.11 },
  },
  'bytedance/seedance-2.0': {
    nonVideoIn: { '480p': 0.08, '720p': 0.18, '1080p': 0.45, '4k': 1.00 },
    videoIn:    { '480p': 0.10, '720p': 0.22, '1080p': 0.55, '4k': 1.25 },
  },
};

// Per-model supported resolutions — used for request validation in generations.ts
export const MODEL_RESOLUTIONS: Record<string, readonly string[]> = {
  'bytedance/seedance-2.0-fast': ['480p', '720p'],
  'bytedance/seedance-2.0-mini': ['480p', '720p'],
  'bytedance/seedance-2.0':      ['480p', '720p', '1080p', '4k'],
};

export function resolveDurationSeconds(requested: number | 'auto'): number {
  if (requested === 'auto') {
    // Per CLAUDE.md Rule 7 / RESEARCH.md A4: placeholder default until a product rule exists.
    return 5;
  }
  if (!Number.isInteger(requested) || requested < 4 || requested > 15) {
    throw new Error('duration must be an integer between 4 and 15 seconds');
  }
  return requested;
}

export const SUPPORTED_MODELS = ['bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0'] as const;
export type SupportedModel = typeof SUPPORTED_MODELS[number];

// Image model flat costs (credits per generation, not per-second). 1 credit = 1¢.
export const IMAGE_MODEL_COSTS: Record<string, number> = {
  'bytedance/seedream-5-lite': 4,
  'bytedance/seedream-4.5': 4,
  'openai/gpt-image-2': 13,
};

export const SUPPORTED_IMAGE_MODELS = [
  'bytedance/seedream-5-lite',
  'bytedance/seedream-4.5',
  'openai/gpt-image-2',
] as const;
export type SupportedImageModel = typeof SUPPORTED_IMAGE_MODELS[number];

// Flat cost for image models — no duration involved (CLAUDE.md Rule 7 does not apply to images)
export function computeImageCostCredits(model: string): number {
  return IMAGE_MODEL_COSTS[model] ?? 0;
}

export function computeCostCredits(input: {
  durationSeconds: number;
  resolution: '480p' | '720p' | '1080p' | '4k';
  model: SupportedModel;
  hasVideoReference?: boolean;
}): number {
  const rates = MODEL_RATES[input.model];
  const rateSet = input.hasVideoReference ? rates.videoIn : rates.nonVideoIn;
  const ratePerSec = rateSet[input.resolution];
  return Math.ceil(input.durationSeconds * ratePerSec * CREDITS_PER_DOLLAR);
}

export async function createGeneration(row: NewGeneration): Promise<{ id: string }> {
  const [created] = await db.insert(generations).values(row).returning({ id: generations.id });
  return created;
}

export async function attachPredictionId(generationId: string, predictionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE generations
    SET replicate_prediction_id = ${predictionId}, status = 'processing'
    WHERE id = ${generationId}::uuid AND status = 'pending'
  `);
}

export async function markCompleted(generationId: string, r2Key: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'completed', r2_key = ${r2Key}, completed_at = now()
    WHERE id = ${generationId}::uuid AND status = 'processing'
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function markFailed(generationId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'failed', completed_at = now()
    WHERE id = ${generationId}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function markQuarantined(generationId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'quarantined', completed_at = now()
    WHERE id = ${generationId}::uuid AND status = 'processing'
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function markRefunded(generationId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'refunded', completed_at = now()
    WHERE id = ${generationId}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function getGenerationByPredictionId(
  predictionId: string,
): Promise<{ id: string; user_id: string; status: GenerationStatus; cost_credits: number; media_type: string } | undefined> {
  const result = await db.execute(sql`
    SELECT id, user_id, status, cost_credits, media_type FROM generations WHERE replicate_prediction_id = ${predictionId}
  `);
  return result.rows?.[0] as
    | { id: string; user_id: string; status: GenerationStatus; cost_credits: number; media_type: string }
    | undefined;
}

const HIDDEN_STATUSES: GenerationStatus[] = ['quarantined', 'deleted'];

// Cursor pagination: cursor is { createdAt, id } of the last visible item (oldest in current page)
// Uses lt(created_at) + DESC order — newest items first. RESEARCH.md Pitfall 3: use lt NOT gt.
export async function listGenerations(
  userId: string,
  cursor?: { createdAt: Date; id: string },
  limit = 20,
) {
  return db
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.user_id, userId),
        notInArray(generations.status, HIDDEN_STATUSES),
        cursor
          ? or(
              lt(generations.created_at, cursor.createdAt),
              and(
                eq(generations.created_at, cursor.createdAt),
                lt(generations.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(generations.created_at), desc(generations.id))
    .limit(limit);
}

// IDOR guard: userId in WHERE clause — never returns another user's row
export async function getGenerationById(
  generationId: string,
  userId: string,
): Promise<typeof generations.$inferSelect | undefined> {
  const result = await db.execute(sql`
    SELECT * FROM generations
    WHERE id = ${generationId}::uuid
      AND user_id = ${userId}::uuid
      AND status NOT IN ('quarantined', 'deleted')
  `);
  return result.rows?.[0] as typeof generations.$inferSelect | undefined;
}

// Atomic soft-delete: ownership check in WHERE clause prevents IDOR Tampering (T-07-02-02)
export async function softDeleteGeneration(generationId: string, userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'deleted'
    WHERE id = ${generationId}::uuid AND user_id = ${userId}::uuid
      AND status NOT IN ('deleted', 'quarantined')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}
