// src/routes/me.ts
// GET /api/me — returns authenticated user's info + current credit state.
// Triggers top-up expiry enforcement before responding (creditService.getUserWithBalance).

import { Router, Request, Response } from 'express';
import { getUserWithBalance } from '../services/creditService';

export const meRouter = Router();

meRouter.get('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const balance = await getUserWithBalance(req.user.dbUserId);

    res.status(200).json({
      user: req.user,
      credits_balance: balance.credits_balance,
      subscription_allotment: balance.subscription_allotment,
      active_topup_balance: balance.active_topup_balance,
      entitlement_level: balance.entitlement_level,
    });
  } catch (error) {
    console.error('[me] Error fetching user balance:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});
