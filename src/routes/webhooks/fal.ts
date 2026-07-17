// src/routes/webhooks/fal.ts
// Fal.ai webhook handler — completion callback for FalProvider.ts's async video endpoints.
// A deliberately smaller sibling of webhooks/replicate.ts: no
// retry/postprocess-mux/face-upload-cleanup paths,
// since this generation type doesn't use any of those (unlike the generic Replicate path, which
// backs many different presets).
//
// CRITICAL: requires express.raw() body parsing — scoped in index.ts BEFORE express.json(),
// same as webhooks/replicate.ts (signature verification needs the exact raw bytes).
// CLAUDE.md Rule 3 (webhook signature verified before any processing) — Fal's own ED25519+JWKS
// scheme, see falWebhookVerify.ts.
// CLAUDE.md Rule 2 (archive to R2 as the first action on success, before any DB status write).

import { Router, Request, Response } from 'express';
import { verifyFalWebhookSignature } from '../../services/falWebhookVerify';
import { archiveToR2 } from '../../services/archivalService';
import { scanForCsam } from '../../services/hiveService';
import { config } from '../../config';
import {
  getGenerationByPredictionId,
  markCompleted,
  markFailed,
  markQuarantined,
  type GenerationByPredictionRow,
} from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { sendGenerationComplete } from '../../services/apnsService';
import { deleteRawFaceUploads } from '../../services/uploadCleanup';
import {
  encodePredictionId,
  FAL_ASYNC_VIDEO_ENDPOINTS,
  falVideoOutputContentType,
} from '../../services/providers/FalProvider';
import { db } from '../../db/client';
import { sql } from 'drizzle-orm';

export const falWebhookRouter = Router();

async function fetchDeviceToken(userId: string): Promise<string | null> {
  const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
  return (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token ?? null;
}

async function resolveGeneration(requestId: string): Promise<GenerationByPredictionRow | undefined> {
  // Fal's callback carries request_id but not endpoint_id. Prediction IDs are stored as
  // "<endpoint>::<request>", so resolve against the small provider allowlist.
  for (const endpointId of FAL_ASYNC_VIDEO_ENDPOINTS) {
    const generation = await getGenerationByPredictionId(encodePredictionId(endpointId, requestId));
    if (generation) return generation;
  }
  return undefined;
}

falWebhookRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  const isValid = await verifyFalWebhookSignature(
    {
      requestId: req.headers['x-fal-webhook-request-id'] as string,
      userId: req.headers['x-fal-webhook-user-id'] as string,
      timestamp: req.headers['x-fal-webhook-timestamp'] as string,
      signature: req.headers['x-fal-webhook-signature'] as string,
    },
    rawBody,
  );

  if (!isValid) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf-8')) as {
      request_id: string;
      status: 'OK' | 'ERROR';
      payload?: { video?: { url?: string } };
      error?: string;
    };

    const generation = await resolveGeneration(payload.request_id);
    if (!generation) {
      console.warn(`[webhook/fal] No generation found for request_id=${payload.request_id}`);
      res.status(200).json({ received: true, skipped: 'generation_not_found' });
      return;
    }

    // Idempotency: already-terminal generation means another path already processed this.
    if (['completed', 'failed', 'refunded', 'quarantined'].includes(generation.status)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    if (payload.status === 'OK') {
      const outputUrl = payload.payload?.video?.url;
      if (!outputUrl) {
        console.error(`[webhook/fal] OK payload missing video.url for ${payload.request_id}`);
        await markFailed(generation.id);
        await refundCredits(generation.user_id, generation.cost_credits, payload.request_id);
        res.status(200).json({ received: true, error: 'missing_output' });
        return;
      }

      const [r2Key, deviceToken] = await Promise.all([
        archiveToR2(outputUrl, generation.id, falVideoOutputContentType(generation.model)),
        fetchDeviceToken(generation.user_id),
      ]);

      if (config.hiveScanEnabled) {
        try {
          const { flagged } = await scanForCsam(r2Key);
          if (flagged) {
            await markQuarantined(generation.id);
            await refundCredits(generation.user_id, generation.cost_credits, `csam-quarantine-${payload.request_id}`);
            console.warn(`[webhook/fal] CSAM flagged: generation ${generation.id} quarantined, credits refunded.`);
            res.status(200).json({ received: true });
            return;
          }
        } catch (hiveError) {
          // Unlike webhooks/replicate.ts, no retry-queue exists for this generation type yet —
          // fail safe (quarantine + refund) rather than risk serving an unscanned video.
          console.error('[webhook/fal] Hive scan error — quarantining fail-safe:', hiveError);
          await markQuarantined(generation.id);
          await refundCredits(generation.user_id, generation.cost_credits, `csam-scan-error-${payload.request_id}`);
          res.status(200).json({ received: true });
          return;
        }
      }

      await markCompleted(generation.id, r2Key);
      await deleteRawFaceUploads(generation); // best-effort, never throws past here

      try {
        if (deviceToken) {
          await sendGenerationComplete(deviceToken, generation.id, 'video');
        }
      } catch (pushError) {
        console.error('[webhook/fal] Push notification failed (non-blocking):', pushError);
      }

      console.log(`[webhook/fal] succeeded: generation ${generation.id} archived to ${r2Key}`);
    } else {
      const refunded = await markFailed(generation.id, 'provider_error');
      if (refunded) {
        await refundCredits(generation.user_id, generation.cost_credits, payload.request_id);
      }
      console.log(`[webhook/fal] failed: generation ${generation.id} (${payload.error ?? 'unknown error'})`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook/fal] Unhandled error processing webhook:', err);
    res.status(200).json({ received: true, error: 'processing_error' });
  }
});
