// src/routes/me.ts
// GET /api/me — returns authenticated user's info + current credit state.
// Triggers top-up expiry enforcement before responding (creditService.getUserWithBalance).

import { Router, Request, Response } from 'express';
import { getUserWithBalance } from '../services/creditService';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { CONCURRENCY_LIMIT, isTier } from '../config/tiers';
import { deleteUserAccount } from '../services/accountDeletionService';
import { grantIfEligible } from '../services/freeCreditGrantService';
import { getFirebaseAdmin } from '../firebase';
import { MergeError, mergeUser } from '../services/userMergeService';

export const meRouter = Router();

meRouter.delete('/', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    await deleteUserAccount(req.user.dbUserId, req.user.uid);
    res.status(204).send();
  } catch (error) {
    console.error('[me] Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

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

    // Paywall tiers (paywall-tiers-plan.md item 5): expose the resolved tier + its concurrency
    // cap so the client can label locked models/surface "X in progress" without hardcoding the
    // tier ladder. NULL entitlement_level (no active subscription) -> tier/parallel_limit null;
    // the hard-paywall gate (entitlementGate) already blocks generation in that state server-side.
    const tier = isTier(balance.entitlement_level) ? balance.entitlement_level : null;

    res.status(200).json({
      user: req.user,
      credits_balance: balance.credits_balance,
      subscription_allotment: balance.subscription_allotment,
      active_topup_balance: balance.active_topup_balance,
      entitlement_level: balance.entitlement_level,
      tier,
      parallel_limit: tier ? CONCURRENCY_LIMIT[tier] : null,
      has_face_consent: hasFaceConsent,
    });
  } catch (error) {
    console.error('[me] Error fetching user balance:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// POST /api/me/free-credits — DeviceCheck-backed, once-per-device guest credit grant.
meRouter.post('/free-credits', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { deviceToken } = req.body ?? {};
  if (typeof deviceToken !== 'string' || deviceToken.trim().length === 0) {
    res.status(400).json({ error: 'deviceToken is required', code: 'MISSING_DEVICE_TOKEN' });
    return;
  }

  try {
    await grantIfEligible(req.user.dbUserId, req.user.uid, deviceToken);
    res.status(204).send();
  } catch (error) {
    console.error('[me] Error processing free credits:', error);
    res.status(500).json({ error: 'Failed to process free credits' });
  }
});

// POST /api/me/merge — fold a verified anonymous account into the authenticated account.
meRouter.post('/merge', async (req: Request, res: Response) => {
  if (!req.user?.dbUserId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const { anonymousUid, anonymousToken } = req.body ?? {};
  if (typeof anonymousUid !== 'string' || anonymousUid.trim().length === 0) {
    res.status(400).json({ error: 'anonymousUid is required', code: 'MISSING_ANONYMOUS_UID' });
    return;
  }
  if (typeof anonymousToken !== 'string' || anonymousToken.trim().length === 0) {
    res.status(400).json({ error: 'anonymousToken is required', code: 'MISSING_ANONYMOUS_TOKEN' });
    return;
  }

  const sourceUid = anonymousUid.trim();
  let decodedToken;
  try {
    decodedToken = await getFirebaseAdmin().auth.verifyIdToken(anonymousToken.trim());
  } catch {
    res.status(401).json({ error: 'Invalid anonymous token', code: 'INVALID_ANONYMOUS_TOKEN' });
    return;
  }

  if (decodedToken.uid !== sourceUid) {
    res.status(401).json({ error: 'Anonymous token UID mismatch', code: 'ANONYMOUS_UID_MISMATCH' });
    return;
  }
  if (decodedToken.firebase?.sign_in_provider !== 'anonymous') {
    res.status(401).json({ error: 'Anonymous provider required', code: 'ANONYMOUS_PROVIDER_REQUIRED' });
    return;
  }

  try {
    const sourceRows = await db.execute(sql`
      SELECT id FROM users WHERE firebase_uid = ${sourceUid} LIMIT 1
    `);
    const source = sourceRows.rows?.[0] as { id: string } | undefined;
    if (!source) {
      res.status(404).json({ error: 'Anonymous user not found', code: 'ANONYMOUS_USER_NOT_FOUND' });
      return;
    }

    await mergeUser(source.id, req.user.dbUserId, sourceUid);
    res.status(204).send();
  } catch (error) {
    if (error instanceof MergeError) {
      const status = error.code === 'ALREADY_MERGED' || error.code === 'SAME_ACCOUNT' ? 409 : 500;
      res.status(status).json({ error: 'Account merge failed', code: error.code });
      return;
    }

    console.error('[me] Error merging anonymous account:', error);
    res.status(500).json({ error: 'Failed to merge account' });
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
