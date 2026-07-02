// src/routes/webhooks/replicate.ts
// Replicate webhook handler.
// CRITICAL: This route requires express.raw() body parsing — scoped in index.ts BEFORE express.json()
// (wired in Plan 04-05). req.body here is a Buffer, never pre-parsed JSON.
// CLAUDE.md Rule 3: verify signature via validateWebhook() on the RAW body before any other processing.
// CLAUDE.md Rule 2: archive to R2 as the FIRST action on success — before any DB write.
// RESEARCH.md Pitfall 4: check generation.status before reprocessing — idempotent on retries.

import { Router, Request, Response } from 'express';
import { validateWebhook } from 'replicate';
import { config } from '../../config';
import { archiveToR2 } from '../../services/archivalService';
import { scanForCsam } from '../../services/hiveService';
import { classifyFailureReason, getGenerationByPredictionId, markCompleted, markFailed, markQuarantined } from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { sendGenerationComplete } from '../../services/apnsService';
import { hiveScanQueue } from '../../queue/hiveScanWorker';
import { db } from '../../db/client';
import { sql } from 'drizzle-orm';

export const replicateWebhookRouter = Router();

async function fetchDeviceToken(userId: string): Promise<string | null> {
  const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
  return (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token ?? null;
}

replicateWebhookRouter.post('/', async (req: Request, res: Response) => {
  const isValid = await validateWebhook({
    id: req.headers['webhook-id'] as string,
    timestamp: req.headers['webhook-timestamp'] as string,
    signature: req.headers['webhook-signature'] as string,
    body: req.body,
    secret: config.replicateWebhookSecret,
  });

  if (!isValid) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  try {
    const payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : JSON.stringify(req.body)) as {
      id: string;
      status: string;
      output?: string | string[];
      error?: string;
    };

    const generation = await getGenerationByPredictionId(payload.id);
    if (!generation) {
      console.warn(`[webhook/replicate] No generation found for prediction_id=${payload.id}`);
      res.status(200).json({ received: true, skipped: 'generation_not_found' });
      return;
    }

    // Idempotency: already-terminal generation means another path already processed this.
    if (['completed', 'failed', 'refunded', 'quarantined'].includes(generation.status)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    if (payload.status === 'succeeded') {
      const outputUrl = Array.isArray(payload.output) ? payload.output[0] : payload.output;
      if (!outputUrl) {
        console.error(`[webhook/replicate] succeeded payload missing output for ${payload.id}`);
        await markFailed(generation.id);
        await refundCredits(generation.user_id, generation.cost_credits, payload.id);
        res.status(200).json({ received: true, error: 'missing_output' });
        return;
      }

      // Determine content type from media_type (stored in DB during POST /api/generations).
      // For images: detect from URL extension if possible, fallback to image/jpeg (default Flux output).
      const mediaType = generation.media_type ?? 'video';
      let contentType = 'video/mp4';
      if (mediaType === 'image') {
        if (outputUrl.includes('.webp')) contentType = 'image/webp';
        else if (outputUrl.includes('.png')) contentType = 'image/png';
        else contentType = 'image/jpeg';
      }

      // CLAUDE.md Rule 2: archive FIRST, before any DB status write. The device-token lookup
      // is a read (not a status write) needed later only for the push — run it concurrently
      // with the archive instead of serially after markCompleted so it doesn't add to the
      // completion→push latency chain.
      const [r2Key, deviceToken] = await Promise.all([
        archiveToR2(outputUrl, generation.id, contentType),
        fetchDeviceToken(generation.user_id),
      ]);

      // Hive CSAM scan — skipped when HIVE_SCAN_ENABLED=false.
      if (config.hiveScanEnabled) {
        let hiveFlagged = false;
        let hiveScanErrored = false;
        try {
          const { flagged } = await scanForCsam(r2Key);
          hiveFlagged = flagged;
        } catch (hiveError) {
          console.error('[webhook/replicate] Hive scan error — queuing retry:', hiveError);
          hiveScanErrored = true;
        }

        if (hiveScanErrored) {
          await hiveScanQueue.add('scan', {
            generationId: generation.id,
            r2Key,
            userId: generation.user_id,
            costCredits: generation.cost_credits,
          });
          console.log(`[webhook/replicate] Hive retry queued for generation ${generation.id}`);
          res.status(200).json({ received: true });
          return;
        } else if (hiveFlagged) {
          await markQuarantined(generation.id);
          await refundCredits(generation.user_id, generation.cost_credits, `csam-quarantine-${payload.id}`);
          console.warn(`[webhook/replicate] CSAM flagged: generation ${generation.id} quarantined, credits refunded.`);
          res.status(200).json({ received: true });
          return;
        }
      }

      await markCompleted(generation.id, r2Key);

      // Best-effort push — isolated, never blocks this response (CLAUDE.md/RESEARCH.md Pitfall 5).
      try {
        if (deviceToken) {
          await sendGenerationComplete(deviceToken, generation.id, mediaType as 'video' | 'image');
        }
      } catch (pushError) {
        console.error('[webhook/replicate] Push notification failed (non-blocking):', pushError);
      }

      console.log(`[webhook/replicate] succeeded: generation ${generation.id} archived to ${r2Key}`);
    } else if (payload.status === 'failed' || payload.status === 'canceled') {
      const reason = classifyFailureReason(payload.error);
      await markFailed(generation.id, reason);
      await refundCredits(generation.user_id, generation.cost_credits, payload.id);
      console.log(`[webhook/replicate] ${payload.status} (${reason}): refunded ${generation.cost_credits} credits to user ${generation.user_id}`);
    } else {
      console.log(`[webhook/replicate] Unhandled status: ${payload.status}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook/replicate] Error processing webhook:', err);
    res.status(200).json({ received: true, error: 'internal_error' });
  }
});

