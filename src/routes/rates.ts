// src/routes/rates.ts
// Public endpoint — no auth required. Returns the model rate table so iOS can compute
// credit costs client-side without hardcoding values in the app bundle.

import { Router } from 'express';
import { MODEL_RATES, CENTS_PER_DOLLAR, IMAGE_MODEL_COSTS, DREAMACTOR_RATE, VIDEO_UPSCALER_RATES, GROK_IMAGINE_CREDITS_PER_SEC, FAL_KLING_V3_STANDARD_RATES, FAL_KLING_O3_STANDARD_RATES, KLING_MOTION_RATE } from '../services/generationService';
import { MODEL_MIN_TIER, CONCURRENCY_LIMIT } from '../config/tiers';

export const ratesRouter = Router();

// Convert dollar/sec rates → credits/sec so clients just do ceil(duration × rate).
// Uses CENTS_PER_DOLLAR (1 credit = 1 cent of provider cost) — NOT CREDITS_PER_DOLLAR,
// which prices subscription/topup grants on a different scale.
ratesRouter.get('/', (_req, res) => {
  const creditRates: Record<string, { nonVideoIn: Record<string, number>; videoIn: Record<string, number> }> = {};
  for (const [model, sets] of Object.entries(MODEL_RATES)) {
    creditRates[model] = {
      nonVideoIn: Object.fromEntries(Object.entries(sets.nonVideoIn).map(([res, r]) => [res, r * CENTS_PER_DOLLAR])),
      videoIn:    Object.fromEntries(Object.entries(sets.videoIn).map(([res, r]) => [res, r * CENTS_PER_DOLLAR])),
    };
  }
  // dreamactorRate: credits per second (flat, no resolution tiers)
  const dreamactorCreditRate = DREAMACTOR_RATE * CENTS_PER_DOLLAR;

  // upscalerRates: same matrix as VIDEO_UPSCALER_RATES but in credits/sec
  const upscalerCreditRates: typeof VIDEO_UPSCALER_RATES = {
    standard: Object.fromEntries(
      Object.entries(VIDEO_UPSCALER_RATES.standard).map(([res, bands]) => [
        res, { lte30: bands.lte30 * CENTS_PER_DOLLAR, gt30: bands.gt30 * CENTS_PER_DOLLAR },
      ]),
    ) as typeof VIDEO_UPSCALER_RATES['standard'],
    pro: Object.fromEntries(
      Object.entries(VIDEO_UPSCALER_RATES.pro).map(([res, bands]) => [
        res, { lte30: bands.lte30 * CENTS_PER_DOLLAR, gt30: bands.gt30 * CENTS_PER_DOLLAR },
      ]),
    ) as typeof VIDEO_UPSCALER_RATES['pro'],
  };

  res.json({
    rates: creditRates,
    imageCosts: IMAGE_MODEL_COSTS,
    dreamactorRate: dreamactorCreditRate,
    upscalerRates: upscalerCreditRates,
    grokImagineRate: GROK_IMAGINE_CREDITS_PER_SEC, // already in credits, flat — no conversion multiply
    falKlingV3StandardRates: {
      audioOff: FAL_KLING_V3_STANDARD_RATES.audioOff * CENTS_PER_DOLLAR,
      audioOn: FAL_KLING_V3_STANDARD_RATES.audioOn * CENTS_PER_DOLLAR,
    },
    falKlingO3StandardRates: {
      audioOff: FAL_KLING_O3_STANDARD_RATES.audioOff * CENTS_PER_DOLLAR,
      audioOn: FAL_KLING_O3_STANDARD_RATES.audioOn * CENTS_PER_DOLLAR,
    },
    klingMotionStandardRate: KLING_MOTION_RATE.std * CENTS_PER_DOLLAR,
    // Paywall tiers (paywall-tiers-plan.md item 5): premium-model minimum tier map, so the client
    // can label locked models (follow-up UI work — not built here). Models absent from this map
    // require only 'basic'. Additive/non-breaking.
    modelMinTier: MODEL_MIN_TIER,
    concurrencyLimit: CONCURRENCY_LIMIT,
  });
});
