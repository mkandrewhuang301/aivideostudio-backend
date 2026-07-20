// src/config/tiers.ts
// Tier taxonomy for the paywall rebuild (paywall-tiers-plan.md, 2026-07-17). Maps each
// dispatchable model id to its minimum entitlement tier, and defines per-tier resolution
// floors + concurrency caps. Model ids are pulled from the real registries in
// services/generationService.ts — never invent an id here.
//
// Product model is guest-first: users.entitlement_level is 'basic' | 'pro' | 'creator' | NULL.
// NULL means no active subscription and may use basic-tier models/resolutions while credits last;
// pro and creator requirements still require the corresponding paid entitlement.

export type Tier = 'basic' | 'pro' | 'creator';

const TIER_RANK: Record<Tier, number> = { basic: 0, pro: 1, creator: 2 };

export function isTier(value: unknown): value is Tier {
  return value === 'basic' || value === 'pro' || value === 'creator';
}

// True if `have` meets or exceeds `need`. Basic is available to every authenticated user,
// including guests with NULL/undefined entitlement; pro and creator still require a real tier.
export function tierAtLeast(have: Tier | null | undefined, need: Tier): boolean {
  if (need === 'basic') return true;
  if (!have) return false;
  return TIER_RANK[have] >= TIER_RANK[need];
}

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// Minimum tier required to dispatch each model. Models absent from this map default to 'basic'
// (the common/core case — see modelMinTier()) — only pro+ models need an explicit entry.
// Derived from the real SUPPORTED_* registries in services/generationService.ts:
//   basic (core): bytedance/seedance-2.0-fast, bytedance/seedance-2.0-mini,
//                  xai/grok-imagine-video-1.5, alibaba/happyhorse-1.1 is EXCLUDED (see below),
//                  gpt-image-2 tiers, everything else not listed.
//   pro+ (premium): bytedance/seedance-2.0 (full, non-mini/non-fast SKU — 1080p/4K-capable),
//                    fal Kling v3 Standard i2v, Kling v3 Motion Control, HappyHorse 1.1.
export const MODEL_MIN_TIER: Record<string, Tier> = {
  'bytedance/seedance-2.0': 'pro',
  'fal-ai/kling-video/v3/standard/image-to-video': 'pro',
  'fal-ai/kling-video/o3/standard/reference-to-video': 'pro',
  'kwaivgi/kling-v3-motion-control': 'pro',
  'alibaba/happyhorse-1.1': 'pro',
};

export function modelMinTier(model: string | undefined | null): Tier {
  if (!model) return 'basic';
  return MODEL_MIN_TIER[model] ?? 'basic';
}

// Resolution floor is independent of model — the same model id (bytedance/seedance-2.0) spans
// multiple resolution tiers. 480p/720p are basic; 1080p needs pro; 4k needs creator.
export function resolutionMinTier(resolution: string | undefined | null): Tier {
  if (resolution === '4k') return 'creator';
  if (resolution === '1080p') return 'pro';
  return 'basic';
}

// Per-tier concurrent (non-terminal: pending/processing) active-generation cap.
export const CONCURRENCY_LIMIT: Record<Tier, number> = {
  basic: 1,
  pro: 2,
  creator: 4,
};
