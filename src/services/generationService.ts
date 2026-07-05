// src/services/generationService.ts
// Generation orchestration: duration resolution, cost calculation, row CRUD, atomic status transitions.
// CLAUDE.md Rule 1: status transitions use the same atomic UPDATE...WHERE...RETURNING guard as creditService.
// CLAUDE.md Rule 7: resolveDurationSeconds NEVER returns -1; resolved before credit deduction or dispatch.

import { db } from '../db/client';
import { generations } from '../db/schema';
import { sql, desc, lt, eq, and, notInArray, or } from 'drizzle-orm';
import type { GenerationStatus, NewGeneration } from '../db/schema';

export const CREDITS_PER_DOLLAR = 50; // subscription/topup grant scale only (revenuecat.ts: 500 credits ≈ $9.99) — NEVER use for per-generation cost math

// Per-generation cost rule (user-specified): 1 credit = 1 cent of provider cost, rounded up.
// Do not use CREDITS_PER_DOLLAR here — that constant prices credit *grants*, not consumption,
// and is calibrated to a different (2¢/credit) scale. Using it for cost math undercharges by 2x.
export const CENTS_PER_DOLLAR = 100;

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
  'bytedance/seedance-2.0-fast':   ['480p', '720p'],
  'bytedance/seedance-2.0-mini':   ['480p', '720p'],
  'bytedance/seedance-2.0':        ['480p', '720p', '1080p', '4k'],
  'xai/grok-imagine-video-1.5':    ['480p', '720p'],
};

// ─── xAI Grok Imagine Video 1.5 (image-to-video, synced audio) ────────────────
// $0.08/sec Replicate cost → 8 credits/sec flat, same across 480p/720p.
// 1 credit = 1¢ direct mapping (IMAGE_MODEL_COSTS convention, same as CENTS_PER_DOLLAR below) —
// hardcoded as a flat constant here rather than computed, since Grok has no per-resolution tiers.
// Mandatory image input (image-to-video only, no text-only mode). Audio is
// always synchronized/on — Replicate schema has no audio toggle for this model.
export const GROK_IMAGINE_CREDITS_PER_SEC = 8;
export const SUPPORTED_GROK_MODELS = ['xai/grok-imagine-video-1.5'] as const;
export type SupportedGrokModel = typeof SUPPORTED_GROK_MODELS[number];

export function computeGrokImagineCost(durationSeconds: number): number {
  return Math.ceil(durationSeconds * GROK_IMAGINE_CREDITS_PER_SEC);
}

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
// Quality is encoded in the model ID; "openai/gpt-image-2" retained for regen of older items.
// Seedream 5 Lite / 4.5 paused (worse output quality than gpt-image-2) — see .planning/STATE.md.
export const IMAGE_MODEL_COSTS: Record<string, number> = {
  'openai/gpt-image-2-high':   13, // $0.128/image
  'openai/gpt-image-2-medium': 5,  // $0.047/image
  'openai/gpt-image-2-low':    2,  // $0.012/image
  'openai/gpt-image-2':        13, // backward compat — defaults to high cost
};

export const SUPPORTED_IMAGE_MODELS = [
  'openai/gpt-image-2-high',
  'openai/gpt-image-2-medium',
  'openai/gpt-image-2-low',
  'openai/gpt-image-2',
] as const;
export type SupportedImageModel = typeof SUPPORTED_IMAGE_MODELS[number];

// Flat cost for image models — no duration involved (CLAUDE.md Rule 7 does not apply to images)
export function computeImageCostCredits(model: string): number {
  return IMAGE_MODEL_COSTS[model] ?? 0;
}

// ─── DreamActor M2.0 (avatar) ─────────────────────────────────────────────────
// $0.05/sec of output video — flat rate, no resolution tiers.
// Inputs: image (portrait) + video (driving). No text prompt. Output: single video URL.
// Source: https://replicate.com/bytedance/dreamactor-m2.0 pricing (2026-07-01)

export const DREAMACTOR_RATE = 0.05; // $/sec

export const SUPPORTED_AVATAR_MODELS = ['bytedance/dreamactor-m2.0'] as const;
export type SupportedAvatarModel = typeof SUPPORTED_AVATAR_MODELS[number];

export function computeDreamActorCost(estimatedDurationSeconds: number): number {
  return Math.ceil(estimatedDurationSeconds * DREAMACTOR_RATE * CENTS_PER_DOLLAR);
}

// ─── ByteDance Video Upscaler ─────────────────────────────────────────────────
// Tiered pricing: Standard/Pro × resolution × fps band (≤30 / >30).
// 'pro' tier is Replicate-allowlist-only — default to 'standard' server-side.
// Source: BytePlus per-minute pricing converted to per-second (2026-07-01).

export const VIDEO_UPSCALER_RATES: Record<
  'standard' | 'pro',
  Record<string, { lte30: number; gt30: number }>
> = {
  standard: {
    '720p':  { lte30: 3.443 / 1000,  gt30: 6.887 / 1000 },
    '1080p': { lte30: 6.887 / 1000,  gt30: 0.013773 },
    '2k':    { lte30: 0.013773,       gt30: 0.027548 },
    '4k':    { lte30: 0.027548,       gt30: 0.055097 },
  },
  pro: {
    '720p':  { lte30: 0.034435,  gt30: 0.068870 },
    '1080p': { lte30: 0.068870,  gt30: 0.137742 },
    '2k':    { lte30: 0.137742,  gt30: 0.275482 },
    '4k':    { lte30: 0.275482,  gt30: 0.550965 },
  },
};

export const SUPPORTED_UPSCALER_MODELS = ['bytedance/video-upscaler'] as const;
export type SupportedUpscalerModel = typeof SUPPORTED_UPSCALER_MODELS[number];

export function computeUpscalerCost(
  estimatedDurationSeconds: number,
  tier: 'standard' | 'pro' = 'standard',
  targetResolution = '720p',
  targetFps = 30,
): number {
  const tierRates = VIDEO_UPSCALER_RATES[tier] ?? VIDEO_UPSCALER_RATES.standard;
  const resRates = tierRates[targetResolution] ?? tierRates['720p'];
  const rate = targetFps > 30 ? resRates.gt30 : resRates.lte30;
  return Math.ceil(estimatedDurationSeconds * rate * CENTS_PER_DOLLAR);
}

// ─── Recraft Crisp Upscale (Enhancer — image path) ────────────────────────────
// Flat per-image cost, distinct from the per-second video upscaler above.
// Input schema is a single field: { image: <uri> } — verified live via Replicate API.
// $0.006/image → cents rule: Math.ceil(0.006 * CENTS_PER_DOLLAR) = 1 credit.
// Source: https://replicate.com/recraft-ai/recraft-crisp-upscale (RESEARCH.md Standard Stack, verified 2026-07-04)

export const RECRAFT_UPSCALE_RATE_DOLLARS = 0.006; // $/image

export const SUPPORTED_IMAGE_UPSCALE_MODELS = ['recraft-ai/recraft-crisp-upscale'] as const;
export type SupportedImageUpscaleModel = typeof SUPPORTED_IMAGE_UPSCALE_MODELS[number];

export function computeImageUpscaleCost(): number {
  return Math.ceil(RECRAFT_UPSCALE_RATE_DOLLARS * CENTS_PER_DOLLAR);
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
  return Math.ceil(input.durationSeconds * ratePerSec * CENTS_PER_DOLLAR);
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
  // Accepts 'pending' in addition to 'processing' to support the OpenAI inline path,
  // where the generation completes in the same request without going through 'processing'.
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'completed', r2_key = ${r2Key}, completed_at = now()
    WHERE id = ${generationId}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

// Order matters: copyright errors ("...may be related to copyright restrictions")
// also contain generic moderation words, so check the copyright keywords first.
export function classifyFailureReason(error: unknown): 'copyright' | 'content_policy' | 'generic_error' {
  if (typeof error !== 'string') return 'generic_error';
  const lower = error.toLowerCase();
  if (
    lower.includes('copyright') ||
    lower.includes('intellectual property') ||
    lower.includes('trademark') ||
    lower.includes('famous') ||
    lower.includes('celebrity') ||
    lower.includes('likeness') ||
    lower.includes('public figure')
  ) {
    return 'copyright';
  }
  if (
    lower.includes('nsfw') ||
    lower.includes('content policy') ||
    lower.includes('safety') ||
    lower.includes('inappropriate') ||
    lower.includes('violat') ||
    lower.includes('prohibited') ||
    lower.includes('not allowed') ||
    lower.includes('restricted') ||
    lower.includes('restriction')
  ) {
    return 'content_policy';
  }
  return 'generic_error';
}

// Transient provider-side infra failures (Replicate/BytePlus hiccups) that are unrelated to the
// prompt or reference media — worth one automatic retry. Checked BEFORE classifyFailureReason in
// the webhook's failure branch; copyright/content-policy errors must never match this and retry.
export function isTransientProviderError(error: unknown): boolean {
  if (typeof error !== 'string') return false;
  const lower = error.toLowerCase();
  return (
    lower.includes('readerror') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('connection') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable')
  );
}

export async function markFailed(
  generationId: string,
  reason: 'content_policy' | 'copyright' | 'generic_error' | 'provider_error' = 'generic_error',
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'failed', completed_at = now(), failure_reason = ${reason}
    WHERE id = ${generationId}::uuid AND status IN ('pending', 'processing')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function markQuarantined(generationId: string): Promise<boolean> {
  // Accepts 'pending' in addition to 'processing' for the OpenAI inline path.
  const result = await db.execute(sql`
    UPDATE generations
    SET status = 'quarantined', completed_at = now()
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

export interface GenerationByPredictionRow {
  id: string;
  user_id: string;
  status: GenerationStatus;
  cost_credits: number;
  media_type: string;
  model: string;
  prompt: string | null;
  params: unknown;
  retry_count: number;
}

export async function getGenerationByPredictionId(
  predictionId: string,
): Promise<GenerationByPredictionRow | undefined> {
  const result = await db.execute(sql`
    SELECT id, user_id, status, cost_credits, media_type, model, prompt, params, retry_count
    FROM generations WHERE replicate_prediction_id = ${predictionId}
  `);
  return result.rows?.[0] as unknown as GenerationByPredictionRow | undefined;
}

// Redispatch guard for the transient-failure auto-retry (webhooks/replicate.ts): only fires once
// per generation (retry_count < 1) and only while still 'processing' — a stale/duplicate webhook
// racing a second retry attempt will no-op here instead of redispatching twice.
export async function reattachForRetry(generationId: string, newPredictionId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations
    SET replicate_prediction_id = ${newPredictionId}, retry_count = retry_count + 1
    WHERE id = ${generationId}::uuid AND status = 'processing' AND retry_count < 1
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
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

// IDOR guard: userId in WHERE — a user can only favorite their own rows (FAV-01)
export async function setGenerationFavorite(
  generationId: string, userId: string, isFavorite: boolean,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE generations SET is_favorite = ${isFavorite}
    WHERE id = ${generationId}::uuid AND user_id = ${userId}::uuid
      AND status NOT IN ('deleted', 'quarantined')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}
