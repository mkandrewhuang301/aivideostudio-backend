// src/routes/me.ts
// GET /api/me — returns authenticated user's info + current credit state.
// Triggers top-up expiry enforcement before responding (creditService.getUserWithBalance).

import { Router, Request, Response } from 'express';
import { getUserWithBalance } from '../services/creditService';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';

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

meRouter.patch('/device-token', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { deviceToken } = req.body ?? {};
  if (!deviceToken || typeof deviceToken !== 'string') {
    res.status(400).json({ error: 'deviceToken is required', code: 'MISSING_DEVICE_TOKEN' });
    return;
  }

  try {
    await db.execute(sql`
      UPDATE users SET apns_device_token = ${deviceToken}, updated_at = now() WHERE id = ${req.user.dbUserId}::uuid
    `);
    res.status(204).send();
  } catch (error) {
    console.error('[me] Error updating device token:', error);
    res.status(500).json({ error: 'Failed to update device token' });
  }
});

meRouter.patch('/preferences', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { preferences } = req.body ?? {};
  if (!preferences || typeof preferences !== 'object') {
    res.status(400).json({ error: 'preferences is required', code: 'MISSING_PREFERENCES' });
    return;
  }

  try {
    await db.execute(sql`
      UPDATE users SET onboarding_preferences = ${JSON.stringify(preferences)}::jsonb, updated_at = now() WHERE id = ${req.user.dbUserId}::uuid
    `);
    res.status(204).send();
  } catch (error) {
    console.error('[me] Error updating preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});
