// src/routes/rates.ts
// Public endpoint — no auth required. Returns the model rate table so iOS can compute
// credit costs client-side without hardcoding values in the app bundle.

import { Router } from 'express';
import { MODEL_RATES, CREDITS_PER_DOLLAR, IMAGE_MODEL_COSTS } from '../services/generationService';

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
  // imageCosts: flat credits per image generation (no per-second math needed)
  res.json({ rates: creditRates, imageCosts: IMAGE_MODEL_COSTS });
});
