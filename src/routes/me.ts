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

    // SC2: expose whether the user has already attested to face-input consent so the iOS
    // client can gate the face-input sheet. Server-authoritative (client sheet is UX only).
    const consentRow = await db.execute(sql`SELECT face_consent_at FROM users WHERE id = ${req.user.dbUserId}::uuid`);
    const hasFaceConsent = Boolean(
      (consentRow?.rows?.[0] as { face_consent_at: string | null } | undefined)?.face_consent_at
    );

    res.status(200).json({
      user: req.user,
      credits_balance: balance.credits_balance,
      subscription_allotment: balance.subscription_allotment,
      active_topup_balance: balance.active_topup_balance,
      entitlement_level: balance.entitlement_level,
      has_face_consent: hasFaceConsent,
    });
  } catch (error) {
    console.error('[me] Error fetching user balance:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// SC2: first-use face-input consent attestation. Idempotent — re-accepting just refreshes
// the timestamp. Server-authoritative (client sheet is UX only; T-09.2 spoofing mitigation).
meRouter.patch('/consent', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    await db.execute(sql`
      UPDATE users SET face_consent_at = now(), updated_at = now() WHERE id = ${req.user.dbUserId}::uuid
    `);
    res.status(204).send();
  } catch (error) {
    console.error('[me] Error recording face consent:', error);
    res.status(500).json({ error: 'Failed to record consent' });
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
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
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
