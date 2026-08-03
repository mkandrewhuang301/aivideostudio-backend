// src/config/adjustmentValidation.ts
//
// API-boundary validation for the Adjust feature's `adjustments` payload (see
// ~/.planning/notes/2026-08-02-adjust-tab-plan.md and src/config/adjustmentLut.ts). Kept separate
// from adjustmentLut.ts on purpose — that file (and its byte-identical Swift port) is the shared
// LUT-generator contract and must not be touched for anything, including validation logic that
// has no bearing on the generated table.
//
// Every value is -1…1 (0 = unchanged) EXCEPT `fade`, which is 0…1. Unknown keys are rejected here
// rather than silently ignored, so a client typo (or a future field added to one side only) fails
// loudly at the API boundary instead of quietly compiling to a no-op LUT.

import type { Adjustments } from './adjustmentLut';

const SIGNED_UNIT_RANGE_KEYS: readonly (keyof Adjustments)[] = [
  'brightness', 'contrast', 'saturation', 'temperature', 'tint',
  'hue', 'highlights', 'shadows', 'whites', 'blacks',
];

const ZERO_TO_ONE_KEYS: readonly (keyof Adjustments)[] = ['fade'];

const ALL_ADJUSTMENT_KEYS: readonly string[] = [...SIGNED_UNIT_RANGE_KEYS, ...ZERO_TO_ONE_KEYS];

/**
 * Validates an `adjustments` request body. Returns null when valid, otherwise a human-readable
 * error message suitable for a 400 response. `null`/`undefined` themselves are NOT validated here
 * — callers decide what an absent/cleared adjustment set means for their route.
 */
export function validateAdjustments(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'adjustments must be an object';
  }
  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALL_ADJUSTMENT_KEYS.includes(key)) {
      return `adjustments.${key} is not a recognized control`;
    }
  }

  for (const key of SIGNED_UNIT_RANGE_KEYS) {
    const value = obj[key as string];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
      return `adjustments.${key} must be a finite number between -1 and 1`;
    }
  }
  for (const key of ZERO_TO_ONE_KEYS) {
    const value = obj[key as string];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return `adjustments.${key} must be a finite number between 0 and 1`;
    }
  }
  return null;
}
