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
  // Alibaba HappyHorse 1.1 — per-resolution, same rate for t2v and i2v (input type doesn't
  // change price). User-verified from the live Replicate page 2026-07-11: $0.14/s @720p, $0.18/s @1080p.
  'alibaba/happyhorse-1.1': {
    nonVideoIn: { '720p': 0.14, '1080p': 0.18 },
    videoIn:    { '720p': 0.14, '1080p': 0.18 },
  },
};

// Per-model supported resolutions — used for request validation in generations.ts
export const MODEL_RESOLUTIONS: Record<string, readonly string[]> = {
  'bytedance/seedance-2.0-fast':   ['480p', '720p'],
  'bytedance/seedance-2.0-mini':   ['480p', '720p'],
  'bytedance/seedance-2.0':        ['480p', '720p', '1080p', '4k'],
  'xai/grok-imagine-video-1.5':    ['480p', '720p'],
  'alibaba/happyhorse-1.1':        ['720p', '1080p'],
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

// 09.3 D-02: config-driven swap point for the Seedance content_policy/copyright fallback
// (webhooks/replicate.ts) — always the first (and only, today) entry in SUPPORTED_GROK_MODELS.
export const PERMISSIVE_I2V_MODEL = SUPPORTED_GROK_MODELS[0];

// ─── Alibaba HappyHorse 1.1 (text-to-video + image-to-video, native audio + lip-sync) ─────────
// Premium general video model. Per-resolution per-second pricing (MODEL_RATES above): $0.14/s @720p,
// $0.18/s @1080p — identical for t2v and i2v. Native audio + multilingual lip-sync is baked into the
// same forward pass (no audio field in the Replicate schema) → treat as ALWAYS ON; never send an
// audio toggle. Duration 3–15s (wider low bound than Seedance/Grok's 4s). v1 ships text-to-video
// (0 images) + single-image image-to-video (1 first-frame image); 2–9 reference-to-video is DEFERRED
// (it needs the "[Image N]" space-token injection, distinct from Seedance's "[ImageN]" logic).
// Source: https://replicate.com/alibaba/happyhorse-1.1 (schema + pricing user-verified 2026-07-11).
export const SUPPORTED_HAPPYHORSE_MODELS = ['alibaba/happyhorse-1.1'] as const;
export type SupportedHappyHorseModel = typeof SUPPORTED_HAPPYHORSE_MODELS[number];

export function computeHappyHorseCost(durationSeconds: number, resolution: string): number {
  const rates = MODEL_RATES['alibaba/happyhorse-1.1'].nonVideoIn; // t2v == i2v rate
  const ratePerSec = rates[resolution] ?? rates['720p'];
  return Math.ceil(durationSeconds * ratePerSec * CENTS_PER_DOLLAR);
}

// HappyHorse accepts 3–15s (vs the shared 4–15s guard) — its own validator so the Seedance/Grok
// path stays unchanged. CLAUDE.md Rule 7: resolves to explicit seconds, never -1.
export function resolveHappyHorseDuration(requested: number | 'auto'): number {
  if (requested === 'auto') return 5;
  if (!Number.isInteger(requested) || requested < 3 || requested > 15) {
    throw new Error('duration must be an integer between 3 and 15 seconds');
  }
  return requested;
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

// ─── Wan 2.2 Animate Replace (character_replace) ──────────────────────────────
// "Replace" mode: swaps the person in a real video with an uploaded character image, keeping
// the ORIGINAL video's background/motion/lighting (inverse of the `avatar` path above, which
// keeps the PHOTO's background) — AI Influencer preset (D-23, added 2026-07-06).
// Apache 2.0 licensed (Tongyi Lab / Wan-AI) — commercial use OK, no royalty.
// Pricing CONFIRMED (user-verified 2026-07-06 from Replicate's own pricing criteria for this
// model): 480p = $0.02/sec (50s per $1), 720p = $0.05/sec (20s per $1) — flat per-second-of-
// output-video billing. v1 always dispatches at 720p (no resolution picker, D-22 precedent).
// Source: https://replicate.com/wan-video/wan-2.2-animate-replace (schema + pricing verified 2026-07-06)

export const CHARACTER_REPLACE_RATE = 0.05; // $/sec at 720p

export const SUPPORTED_CHARACTER_REPLACE_MODELS = ['wan-video/wan-2.2-animate-replace'] as const;
export type SupportedCharacterReplaceModel = typeof SUPPORTED_CHARACTER_REPLACE_MODELS[number];

export function computeCharacterReplaceCost(estimatedDurationSeconds: number): number {
  return Math.ceil(estimatedDurationSeconds * CHARACTER_REPLACE_RATE * CENTS_PER_DOLLAR);
}

// ─── Faceswap (inline OpenAI gpt-image-2) ────────────────────────────────────
// Image-only face swap: swap_image (source face) onto target_image, dispatched INLINE to
// gpt-image-2's /v1/images/edits (src/services/openaiImageService.ts generateFaceswap) — NOT
// easel/advanced-face-swap, which was REMOVED from Replicate (404 confirmed 2026-07-09, 09.2-12).
// FLAT per-run cost at the gpt-image-2-medium tier (5 credits), no duration.
export const SUPPORTED_FACESWAP_MODELS = ['openai/gpt-image-2-medium'] as const;
export type SupportedFaceswapModel = typeof SUPPORTED_FACESWAP_MODELS[number];
export function computeFaceswapCost(): number {
  return IMAGE_MODEL_COSTS['openai/gpt-image-2-medium'];
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

// D-04: jsonb merge onto generations.params — used by the ffmpeg mux worker to stamp
// silent_master_r2_key / applied_audio_r2_key pointers after markCompleted, without a migration
// (params is already jsonb; mirrors the ad-hoc `postprocess` field precedent, RESEARCH.md A4).
export async function mergeGenerationParams(generationId: string, patch: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE generations
    SET params = COALESCE(params, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${generationId}::uuid
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
    lower.includes('restriction') ||
    // BytePlus/Seedance catch-all content-moderation code: "The input or output was
    // flagged as sensitive ... (E005)". Opaque — the SAME code fires for real faces,
    // copyrighted IP, and NSFW, so it cannot be sub-classified beyond content_policy.
    // (Real-face stills are the common trigger; the durable fix is routing those to the
    // permissive i2v path so they never reach Seedance — see 09.3 D-02.)
    lower.includes('flagged as sensitive') ||
    lower.includes('sensitive') ||
    lower.includes('e005')
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
  // Optional (2026-07-12): pass when the media was already archived to R2 before the failure
  // (e.g. hiveScanWorker's final-retry-exhausted path) — without this, that R2 object had no DB
  // reference at all once the row failed (markCompleted is the only other writer of r2_key), a
  // true orphan with no way to ever find or clean it up. `failed` status never exposes video_url
  // regardless (that check is `status === 'completed' && r2_key`), so recording it here doesn't
  // risk serving unscanned content — it only makes the row auditable/cleanable instead of lost.
  r2Key?: string,
): Promise<boolean> {
  const result = r2Key
    ? await db.execute(sql`
        UPDATE generations
        SET status = 'failed', completed_at = now(), failure_reason = ${reason}, r2_key = ${r2Key}
        WHERE id = ${generationId}::uuid AND status IN ('pending', 'processing')
        RETURNING id
      `)
    : await db.execute(sql`
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
