// src/middleware/entitlementGate.ts
// Tier gating for POST /api/generations (paywall-tiers-plan.md Part 1). Guests with a NULL
// entitlement_level may dispatch basic models/resolutions while credits last; pro and creator
// requirements remain subscription-gated.
//
// Placement (generations.ts chain): AFTER prepareCost (needs req._resolved.model/resolution) and
// BEFORE creditCheckMiddleware (a block deducts NO credits — mirrors celebrityCheckMiddleware/
// inputMediaGate's "no charge on block" contract).

import { Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { isTier, maxTier, modelMinTier, resolutionMinTier, tierAtLeast, type Tier } from '../config/tiers';

export async function getUserTier(userId: string): Promise<Tier | null> {
  const result = await db.execute(sql`SELECT entitlement_level FROM users WHERE id = ${userId}::uuid`);
  const row = result.rows?.[0] as { entitlement_level: string | null } | undefined;
  return isTier(row?.entitlement_level) ? row!.entitlement_level : null;
}

export async function entitlementGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const resolved = req._resolved;
  const dbUserId = req.user?.dbUserId;
  if (!resolved || !dbUserId) {
    next();
    return;
  }

  // Presets are tier-agnostic by product principle: a curated preset is open to EVERY user,
  // regardless of which (possibly pro) model or resolution powers it. Tier gating exists only for
  // freeform surfaces where the user picks the model/resolution themselves (Create, and later the
  // Movie Creator). So a preset request defaults to basic and NEVER inherits the model's tier —
  // this makes "no preset can accidentally 403" true by construction, not by remembering to stamp
  // every new preset with min_tier: 'basic'. A preset may still explicitly opt into a higher tier
  // via min_tier, but the default is open. Freeform (no _preset) keeps the model + resolution gate.
  const required: Tier = req._preset
    ? (req._preset.min_tier ?? 'basic')
    : maxTier(modelMinTier(resolved.model), resolutionMinTier(resolved.resolution));

  try {
    const tier = await getUserTier(dbUserId);
    if (!tierAtLeast(tier, required)) {
      res.status(403).json({
        error: `This generation requires a ${required} plan or higher.`,
        code: 'TIER_REQUIRED',
        required_tier: required,
      });
      return;
    }
    next();
  } catch (err) {
    console.error('[entitlementGate] error checking tier — failing safe (block):', err);
    res.status(403).json({
      error: 'We could not verify your plan right now. Please try again.',
      code: 'TIER_CHECK_ERROR',
    });
  }
}
