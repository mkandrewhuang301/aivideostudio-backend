// src/services/generationService.ts
// Generation orchestration: duration resolution, cost calculation, row CRUD, atomic status transitions.
// CLAUDE.md Rule 1: status transitions use the same atomic UPDATE...WHERE...RETURNING guard as creditService.
// CLAUDE.md Rule 7: resolveDurationSeconds NEVER returns -1; resolved before credit deduction or dispatch.

import { db } from '../db/client';
import { generations } from '../db/schema';
import { sql } from 'drizzle-orm';
import type { GenerationStatus, NewGeneration } from '../db/schema';

const CREDITS_PER_DOLLAR = 50; // mirrors SUBSCRIPTION_CREDITS/TOPUP_CREDITS scale in revenuecat.ts (500 credits ≈ $9.99)
const RATE_PER_SECOND_720P = 0.15; // Replicate Seedance 2.0 Fast, 720p, non_video_in

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

export function computeCostCredits(input: { durationSeconds: number; resolution: '480p' | '720p' }): number {
  // Resolution multiplier: 480p=0.5x, 720p=1x (Seedance only supports these two resolutions).
  const multiplier = input.resolution === '480p' ? 0.5 : 1;
  const dollarCost = input.durationSeconds * RATE_PER_SECOND_720P * multiplier;
  return Math.ceil(dollarCost * CREDITS_PER_DOLLAR);
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
): Promise<{ id: string; user_id: string; status: GenerationStatus; cost_credits: number } | undefined> {
  const result = await db.execute(sql`
    SELECT id, user_id, status, cost_credits FROM generations WHERE replicate_prediction_id = ${predictionId}
  `);
  return result.rows?.[0] as
    | { id: string; user_id: string; status: GenerationStatus; cost_credits: number }
    | undefined;
}
