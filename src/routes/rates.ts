// src/routes/rates.ts
// Public endpoint — no auth required. Returns the model rate table so iOS can compute
// credit costs client-side without hardcoding values in the app bundle.

import { Router } from 'express';
import { MODEL_RATES, CREDITS_PER_DOLLAR, IMAGE_MODEL_COSTS, DREAMACTOR_RATE, VIDEO_UPSCALER_RATES, GROK_IMAGINE_CREDITS_PER_SEC } from '../services/generationService';

export const ratesRouter = Router();

// Convert dollar/sec rates → credits/sec so clients just do ceil(duration × rate).
// Internal CREDITS_PER_DOLLAR conversion stays server-side.
ratesRouter.get('/', (_req, res) => {
  const creditRates: Record<string, { nonVideoIn: Record<string, number>; videoIn: Record<string, number> }> = {};
  for (const [model, sets] of Object.entries(MODEL_RATES)) {
    creditRates[model] = {
      nonVideoIn: Object.fromEntries(Object.entries(sets.nonVideoIn).map(([res, r]) => [res, r * CREDITS_PER_DOLLAR])),
      videoIn:    Object.fromEntries(Object.entries(sets.videoIn).map(([res, r]) => [res, r * CREDITS_PER_DOLLAR])),
    };
  }
  // dreamactorRate: credits per second (flat, no resolution tiers)
  const dreamactorCreditRate = DREAMACTOR_RATE * CREDITS_PER_DOLLAR;

  // upscalerRates: same matrix as VIDEO_UPSCALER_RATES but in credits/sec
  const upscalerCreditRates: typeof VIDEO_UPSCALER_RATES = {
    standard: Object.fromEntries(
      Object.entries(VIDEO_UPSCALER_RATES.standard).map(([res, bands]) => [
        res, { lte30: bands.lte30 * CREDITS_PER_DOLLAR, gt30: bands.gt30 * CREDITS_PER_DOLLAR },
      ]),
    ) as typeof VIDEO_UPSCALER_RATES['standard'],
    pro: Object.fromEntries(
      Object.entries(VIDEO_UPSCALER_RATES.pro).map(([res, bands]) => [
        res, { lte30: bands.lte30 * CREDITS_PER_DOLLAR, gt30: bands.gt30 * CREDITS_PER_DOLLAR },
      ]),
    ) as typeof VIDEO_UPSCALER_RATES['pro'],
  };

  res.json({
    rates: creditRates,
    imageCosts: IMAGE_MODEL_COSTS,
    dreamactorRate: dreamactorCreditRate,
    upscalerRates: upscalerCreditRates,
    grokImagineRate: GROK_IMAGINE_CREDITS_PER_SEC, // already in credits, flat — no CREDITS_PER_DOLLAR multiply
  });
});
