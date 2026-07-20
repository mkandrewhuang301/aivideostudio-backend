// src/routes/webhooks/revenuecat.ts
// RevenueCat webhook handler.
// CRITICAL: This route is registered OUTSIDE /api in index.ts — it does NOT use authMiddleware.
// RevenueCat calls this server-to-server using a shared Bearer token (NOT HMAC-SHA256).
// RESEARCH.md Pattern 6: "There is NO HMAC-SHA256 body signing in RevenueCat webhooks."
// RESEARCH.md Pitfall 6: ALWAYS return 200 on business logic errors — RevenueCat retries on non-2xx.

import { Router, Request, Response } from 'express';
import { config } from '../../config';
import { redis } from '../../redis/client';
import { db } from '../../db/client';
import { sql } from 'drizzle-orm';
import { grantCredits, clawbackCredits } from '../../services/creditService';

export const revenueCatWebhookRouter = Router();

// Map from RevenueCat product_id to credit quantity granted per billing period.
// Replicate Seedance 2.0 Fast $0.15/sec | ~66 credits per 6s video at 720p
// Annual plans: INITIAL_PURCHASE grants first month only; BullMQ cron (Phase 4) grants subsequent months.
const SUBSCRIPTION_CREDITS: Record<string, number> = {
  'com.fantasiaai.basic_monthly':   500,   // $9.99/mo  → ~7 videos
  'com.fantasiaai.basic_yearly':    500,   // $95.88/yr → $7.99/mo equivalent (first month grant)
  'com.fantasiaai.pro_monthly':     1400,  // $24.99/mo → ~21 videos
  'com.fantasiaai.pro_yearly':      1400,  // $239.88/yr → $19.99/mo equivalent (first month grant)
  'com.fantasiaai.creator_monthly': 5800,  // $99.99/mo → ~87 videos
  'com.fantasiaai.creator_yearly':  5800,  // $959.88/yr → $79.99/mo equivalent (first month grant)
};

// Top-up consumable packs (90-day expiry per D-08). Progressive value — better per-credit rate higher up.
const TOPUP_CREDITS: Record<string, number> = {
  'com.fantasiaai.topup_9_99':  500,   // $9.99  → ~7 videos
  'com.fantasiaai.topup_24_99': 1400,  // $24.99 → ~21 videos
  'com.fantasiaai.topup_49_99': 2900,  // $49.99 → ~43 videos
  'com.fantasiaai.topup_99_99': 5800,  // $99.99 → ~87 videos
};

// Map from RevenueCat product_id to entitlement level stored on users.entitlement_level.
const PRODUCT_ENTITLEMENT: Record<string, string> = {
  'com.fantasiaai.basic_monthly':   'basic',
  'com.fantasiaai.basic_yearly':    'basic',
  'com.fantasiaai.pro_monthly':     'pro',
  'com.fantasiaai.pro_yearly':      'pro',
  'com.fantasiaai.creator_monthly': 'creator',
  'com.fantasiaai.creator_yearly':  'creator',
};

// Yearly product IDs handled by the monthly cron (yearlyGrantWorker) for months 2–N.
const YEARLY_PRODUCT_IDS = new Set([
  'com.fantasiaai.basic_yearly',
  'com.fantasiaai.pro_yearly',
  'com.fantasiaai.creator_yearly',
]);

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHLY_GRANT_TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days — outlasts any calendar month

function verifyAuthorization(req: Request): boolean {
  const authHeader = req.headers['authorization'];
  return authHeader === `Bearer ${config.revenueCatWebhookSecret}`;
}

revenueCatWebhookRouter.post('/', async (req: Request, res: Response) => {
  // Step 1: Verify shared secret (RESEARCH.md Pattern 6)
  if (!verifyAuthorization(req)) {
    // Never logged before this point — a secret/header mismatch produced ZERO log output,
    // indistinguishable from RC never calling this endpoint at all. Log presence/shape only,
    // never the header value itself.
    console.warn('[webhook/revenuecat] Unauthorized: Authorization header did not match REVENUECAT_WEBHOOK_SECRET', {
      hasAuthHeader: Boolean(req.headers['authorization']),
      path: req.originalUrl,
    });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const event = req.body?.event;
  if (!event) {
    // Malformed payload — return 200 to prevent RC retry (Pitfall 6)
    res.status(200).json({ received: true, skipped: 'no event' });
    return;
  }

  const {
    type: eventType,
    app_user_id: firebaseUid,
    transaction_id: transactionId,
    product_id: productId,
    environment,
  } = event as {
    type: string;
    app_user_id: string;
    transaction_id: string;
    product_id: string;
    entitlement_ids?: string[];
    environment?: string;
  };

  // Diagnostic log for every event — cheap, and turns "did the webhook even fire, and for
  // which user/product" into a one-line grep instead of a multi-step investigation. In
  // particular this surfaces `$RCAnonymousID:...` app_user_ids, which indicate the purchase
  // was made before Purchases.shared.logIn(firebaseUid) completed on the client — those
  // purchases can never be matched to a user below and are silently skipped.
  console.log('[webhook/revenuecat] event', { eventType, app_user_id: firebaseUid, productId, transactionId, environment });

  // ALWAYS wrap business logic in try/catch and return 200 (Pitfall 6)
  try {
    // Step 2: Idempotency check (A7: apply to ALL event types, not just REFUND)
    const idempotencyKey = `rc_webhook:${transactionId}`;
    const isNew = await redis.set(idempotencyKey, '1', 'EX', 604800, 'NX'); // 7-day TTL per D-21
    if (!isNew) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    // Step 3: Look up user by Firebase UID. If RevenueCat delivers an event
    // after an anonymous account was merged, resolve the retained source UID
    // through user_merges so credits land on the authenticated target.
    // Pitfall 3: Webhook may arrive before user row exists — return 200, let RC retry naturally.
    // BUT: auth middleware already upserts the user row on every authenticated request.
    // In practice, the purchase is initiated after sign-in, so the user row exists.
    const userRows = await db.execute(sql`
      SELECT
        COALESCE(merge_target.id, source.id) AS id,
        COALESCE(merge_target.entitlement_level, source.entitlement_level) AS entitlement_level
      FROM users AS source
      LEFT JOIN user_merges AS account_merge ON account_merge.from_user_id = source.id
      LEFT JOIN users AS merge_target ON merge_target.id = account_merge.to_user_id
      WHERE source.firebase_uid = ${firebaseUid}
      LIMIT 1
    `);

    if (!userRows.rows || userRows.rows.length === 0) {
      console.warn(`[webhook/revenuecat] User not found for firebase_uid=${firebaseUid}. Skipping.`);
      // Delete idempotency key so RC can retry when user row exists
      await redis.del(idempotencyKey);
      res.status(200).json({ received: true, skipped: 'user_not_found' });
      return;
    }

    const userRow = userRows.rows[0] as { id: string; entitlement_level: string | null };
    const dbUserId = userRow.id;

    // Step 4: Handle event types
    if (eventType === 'INITIAL_PURCHASE' || eventType === 'RENEWAL') {
      const creditsToGrant = SUBSCRIPTION_CREDITS[productId];
      const entitlementLevel = PRODUCT_ENTITLEMENT[productId];

      if (!creditsToGrant || !entitlementLevel) {
        console.warn(`[webhook/revenuecat] Unknown product_id: ${productId}`);
        res.status(200).json({ received: true, skipped: 'unknown_product' });
        return;
      }

      // Always record which product the user is subscribed to.
      // COALESCE preserves the original start date across RENEWAL events.
      await db.execute(sql`
        UPDATE users
        SET entitlement_level = ${entitlementLevel},
            subscription_product_id = ${productId},
            subscription_started_at = COALESCE(subscription_started_at, now()),
            updated_at = now()
        WHERE id = ${dbUserId}::uuid
      `);

      if (YEARLY_PRODUCT_IDS.has(productId)) {
        // Yearly subscriptions: months 2–N are handled by yearlyGrantWorker cron.
        // Use NX on the monthly key so whichever fires first (this event or the cron) wins,
        // and the other skips — preventing double-granting in the same calendar month.
        const monthKey = currentMonthKey();
        const idempotencyKey = `yearly_monthly_grant:${dbUserId}:${monthKey}`;
        const isNew = await redis.set(idempotencyKey, '1', 'EX', MONTHLY_GRANT_TTL_SECONDS, 'NX');
        if (isNew) {
          const referenceId = `yearly-monthly-${dbUserId}-${monthKey}`;
          await grantCredits(dbUserId, creditsToGrant, 'subscription_grant', referenceId);
          console.log(`[webhook/revenuecat] ${eventType}: granted ${creditsToGrant} credits to user ${dbUserId} (${entitlementLevel} yearly, ${monthKey})`);
        } else {
          console.log(`[webhook/revenuecat] ${eventType}: cron already granted for ${dbUserId} in ${monthKey} — skipping`);
        }
      } else {
        // Monthly subscriptions: grant directly — RevenueCat RENEWAL IS the monthly trigger.
        await grantCredits(dbUserId, creditsToGrant, 'subscription_grant', transactionId);
        console.log(`[webhook/revenuecat] ${eventType}: granted ${creditsToGrant} credits to user ${dbUserId} (${entitlementLevel})`);
      }

    } else if (eventType === 'NON_RENEWING_PURCHASE') {
      // Top-up consumable purchase (D-08: expires 90 days from purchase)
      const creditsToGrant = TOPUP_CREDITS[productId];

      if (!creditsToGrant) {
        console.warn(`[webhook/revenuecat] Unknown top-up product_id: ${productId}`);
        res.status(200).json({ received: true, skipped: 'unknown_product' });
        return;
      }

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 90); // D-08: 90-day expiry

      if (!userRow.entitlement_level) {
        console.warn(
          '[webhook/revenuecat] NON_RENEWING_PURCHASE from non-subscriber user=',
          dbUserId,
          'product=',
          productId,
          '— granting anyway per D-13',
        );
      } else {
        console.log(
          '[webhook/revenuecat] NON_RENEWING_PURCHASE granted to subscriber user=',
          dbUserId,
          'product=',
          productId,
        );
      }

      await grantCredits(dbUserId, creditsToGrant, 'topup_grant', transactionId, expiresAt);

      console.log(`[webhook/revenuecat] NON_RENEWING_PURCHASE: granted ${creditsToGrant} credits (expires ${expiresAt.toISOString()}) to user ${dbUserId}`);

    } else if (eventType === 'REFUND') {
      // Subscription or top-up refunded — clawback the credits (D-21).
      // Check subscriptions first, then top-ups; both need clawback.
      const subscriptionCredits = SUBSCRIPTION_CREDITS[productId];
      const creditsToClawback = subscriptionCredits ?? TOPUP_CREDITS[productId];

      if (!creditsToClawback) {
        console.warn(`[webhook/revenuecat] REFUND for unknown product_id: ${productId}. Skipping credit clawback.`);
        res.status(200).json({ received: true, skipped: 'unknown_product' });
        return;
      }

      await clawbackCredits(dbUserId, creditsToClawback, transactionId);

      // Only clear entitlement + subscription_product_id for subscription refunds.
      // Top-up refunds don't affect subscription status.
      if (subscriptionCredits) {
        await db.execute(sql`
          UPDATE users
          SET entitlement_level = NULL,
              subscription_product_id = NULL,
              subscription_started_at = NULL,
              updated_at = now()
          WHERE id = ${dbUserId}::uuid
        `);
      }

      console.log(`[webhook/revenuecat] REFUND: clawback ${creditsToClawback} credits from user ${dbUserId}`);

    } else if (eventType === 'CANCELLATION' || eventType === 'EXPIRATION') {
      // Subscription cancelled or expired — clear entitlement_level (D-22b: takes effect at renewal)
      // For CANCELLATION: entitlement stays active until period ends; EXPIRATION is when it actually ends.
      if (eventType === 'EXPIRATION') {
        await db.execute(sql`
          UPDATE users
          SET entitlement_level = NULL,
              subscription_product_id = NULL,
              subscription_started_at = NULL,
              updated_at = now()
          WHERE id = ${dbUserId}::uuid
        `);
        console.log(`[webhook/revenuecat] EXPIRATION: cleared entitlement for user ${dbUserId}`);
      } else {
        console.log(`[webhook/revenuecat] CANCELLATION: no immediate action (entitlement active until period end)`);
      }
    } else {
      // Unknown event type — log and acknowledge (Pitfall 6: always 200)
      console.log(`[webhook/revenuecat] Unhandled event type: ${eventType}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    // CRITICAL: log the error but return 200 — RevenueCat retries on non-2xx (Pitfall 6)
    console.error('[webhook/revenuecat] Error processing event:', err);
    res.status(200).json({ received: true, error: 'internal_error' });
  }
});
