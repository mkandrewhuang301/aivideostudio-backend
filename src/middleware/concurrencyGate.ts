// src/middleware/concurrencyGate.ts
// Per-user active-generation concurrency cap by tier (paywall-tiers-plan.md Part 1, item 4):
// basic 1, pro 2, creator 4. Counts generations in a non-terminal status (pending/processing) at
// dispatch time and rejects with 429 when the user is already at their tier's cap.
//
// Placement (generations.ts chain): alongside entitlementGate, BEFORE creditCheckMiddleware — a
// block deducts NO credits (mirrors celebrityCheckMiddleware/inputMediaGate/entitlementGate).
//
// Atomicity: a simple count-then-insert — two concurrent requests can both pass the count check
// before either row is inserted, briefly exceeding the cap by 1. Documented and accepted as a v1
// tradeoff per the plan; no new locking infra added.

import { Request, Response, NextFunction } from 'express';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { CONCURRENCY_LIMIT } from '../config/tiers';
import { getUserTier } from './entitlementGate';

export async function countActiveGenerations(userId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM generations
    WHERE user_id = ${userId}::uuid AND status IN ('pending', 'processing')
  `);
  const row = result.rows?.[0] as { count: number | string } | undefined;
  return Number(row?.count ?? 0);
}

export async function concurrencyGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const dbUserId = req.user?.dbUserId;
  if (!dbUserId) {
    next();
    return;
  }

  try {
    // NULL entitlement defaults to the 'basic' cap here — entitlementGate (mounted immediately
    // before this) already rejects a NULL-entitlement user, so this fallback is unreachable in
    // practice; it exists only so this middleware never crashes if ever reordered.
    const tier = await getUserTier(dbUserId);
    const limit = CONCURRENCY_LIMIT[tier ?? 'basic'];
    const active = await countActiveGenerations(dbUserId);
    if (active >= limit) {
      res.status(429).json({
        error: `You have ${active} generation${active === 1 ? '' : 's'} already in progress (limit ${limit}).`,
        code: 'CONCURRENCY_LIMIT',
        limit,
      });
      return;
    }
    next();
  } catch (err) {
    // Fail safe (block) — mirrors inputMediaGate/entitlementGate's error handling convention in
    // this codebase, favoring correctness over availability during a transient DB error.
    console.error('[concurrencyGate] error checking active generation count — failing safe (block):', err);
    res.status(429).json({
      error: 'We could not verify your generation limit right now. Please try again.',
      code: 'CONCURRENCY_CHECK_ERROR',
    });
  }
}
