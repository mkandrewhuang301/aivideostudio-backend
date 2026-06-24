// src/middleware/creditCheck.ts
// Atomic credit check + deduction middleware.
// Must be applied AFTER authMiddleware (requires req.user.dbUserId).
// Returns 402 if balance < cost; calls next() if deduction succeeds.
// CLAUDE.md Rule 1: deduction is atomic — see creditService.deductCredits.

import { Request, Response, NextFunction } from 'express';
import { deductCredits } from '../services/creditService';

// Extend Request type with generationCost (set on success for downstream handlers)
declare global {
  namespace Express {
    interface Request {
      generationCost?: number;
    }
  }
}

export async function creditCheckMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const cost = Number(req.body?.cost_credits);

  if (!cost || cost <= 0 || !Number.isInteger(cost)) {
    res.status(400).json({ error: 'Invalid cost_credits: must be a positive integer', code: 'INVALID_COST' });
    return;
  }

  const dbUserId = req.user?.dbUserId;
  if (!dbUserId) {
    res.status(401).json({ error: 'User not authenticated', code: 'UNAUTHENTICATED' });
    return;
  }

  try {
    const success = await deductCredits(dbUserId, cost);

    if (!success) {
      res.status(402).json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS' });
      return;
    }

    req.generationCost = cost;
    next();
  } catch (error) {
    console.error('[creditCheck] Unexpected error:', error);
    res.status(500).json({ error: 'Credit check failed' });
  }
}
