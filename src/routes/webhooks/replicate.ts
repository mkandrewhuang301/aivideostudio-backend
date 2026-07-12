// src/routes/webhooks/replicate.ts
// Replicate webhook handler.
// CRITICAL: This route requires express.raw() body parsing — scoped in index.ts BEFORE express.json()
// (wired in Plan 04-05). req.body here is a Buffer, never pre-parsed JSON.
// CLAUDE.md Rule 3: verify signature via validateWebhook() on the RAW body before any other processing.
// CLAUDE.md Rule 2: archive to R2 as the FIRST action on success — before any DB write.
// RESEARCH.md Pitfall 4: check generation.status before reprocessing — idempotent on retries.

import { Router, Request, Response } from 'express';
import { validateWebhook } from 'replicate';
import { config, getReplicateWebhookUrl } from '../../config';
import { archiveToR2, getUploadPresignedUrl } from '../../services/archivalService';
import { scanForCsam } from '../../services/hiveService';
import {
  classifyFailureReason,
  getGenerationByPredictionId,
  isTransientProviderError,
  markCompleted,
  markFailed,
  markQuarantined,
  PERMISSIVE_I2V_MODEL,
  reattachForRetry,
  SUPPORTED_MODELS,
  type GenerationByPredictionRow,
} from '../../services/generationService';
import { refundCredits } from '../../services/creditService';
import { sendGenerationComplete } from '../../services/apnsService';
import { hiveScanQueue } from '../../queue/hiveScanWorker';
import { ffmpegQueue } from '../../queue/ffmpegWorker';
import { db } from '../../db/client';
import { referenceUploads } from '../../db/schema';
import { sql, inArray } from 'drizzle-orm';
import { ReplicateProvider } from '../../services/providers/ReplicateProvider';
import type { GenerationInput } from '../../services/providers/ModelProvider';
import { deleteRawFaceUploads } from '../../services/uploadCleanup';

export const replicateWebhookRouter = Router();

const provider = new ReplicateProvider();

async function fetchDeviceToken(userId: string): Promise<string | null> {
  const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
  return (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token ?? null;
}

// T-09.3-10: params.postprocess is jsonb and (per 09.3-05) will eventually be stamped by our own
// presetResolver — but until that lands, and defensively even after, never trust audio_r2_key as
// an arbitrary fetch target. It must look like one of our own internal R2 keys (assets/ prefix),
// never an absolute URL — the ffmpeg worker only ever presigns+fetches R2 keys, so an unexpected
// key here would otherwise let a tampered request pull an arbitrary object out of our own bucket.
function isValidPostprocessAudioKey(key: string): boolean {
  return key.startsWith('assets/') && !key.includes('://');
}

// Reconstructs the same GenerationInput the original dispatch used, from the generation row's
// stored model/prompt/params — with FRESH presigned URLs for any reference uploads (the original
// presigned URLs are 1-hour TTL and may be stale/expired by the time a retry dispatches).
async function buildRetryInput(generation: GenerationByPredictionRow): Promise<GenerationInput> {
  const params = (generation.params ?? {}) as Record<string, unknown>;
  const refUploadIds: string[] = Array.isArray(params.ref_upload_ids) ? (params.ref_upload_ids as string[]) : [];

  let referenceImages: string[] | undefined;
  let referenceVideos: string[] | undefined;
  if (refUploadIds.length > 0) {
    const rows = await db.select().from(referenceUploads).where(inArray(referenceUploads.id, refUploadIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images: string[] = [];
    const videos: string[] = [];
    for (const id of refUploadIds) {
      const row = byId.get(id);
      if (!row) continue;
      const url = await getUploadPresignedUrl(row.r2_key);
      if (row.mime_type.startsWith('video/')) videos.push(url);
      else images.push(url);
    }
    referenceImages = images.length > 0 ? images : undefined;
    referenceVideos = videos.length > 0 ? videos : undefined;
  }

  return {
    prompt: generation.prompt ?? '',
    model: generation.model,
    mediaType: 'video',
    durationSeconds: params.duration as number,
    resolution: params.resolution as GenerationInput['resolution'],
    aspectRatio: params.aspect_ratio as string,
    audioEnabled: Boolean(params.audio_enabled),
    referenceImages,
    referenceVideos,
  };
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
            mediaType: mediaType as 'video' | 'image',
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

      // 09.3 SC1: params.postprocess (stamped later by presetResolver, 09.3-05) routes the just-
      // archived clip through the ffmpeg worker (mux trend audio / concat clips) instead of
      // marking completed immediately — the worker itself calls markCompleted once ffmpeg is
      // done. Only reachable once Hive has passed (or is disabled) above, so CSAM scanning is
      // never bypassed for postprocessed generations either.
      const params = (generation.params ?? {}) as Record<string, unknown>;
      const postprocess = params.postprocess as { op?: string; audio_r2_key?: string } | undefined;
      const postprocessOp = postprocess?.op;
      if (postprocessOp === 'mux' || postprocessOp === 'concat') {
        const audioR2Key = postprocess?.audio_r2_key;
        if (audioR2Key !== undefined && !isValidPostprocessAudioKey(audioR2Key)) {
          console.error(
            `[webhook/replicate] Rejecting postprocess for generation ${generation.id}: invalid audio_r2_key (must be an assets/-prefixed R2 key, not a URL)`,
          );
          // Fall through to the normal markCompleted path below rather than trust a possibly-
          // tampered value or silently drop the user's paid-for generation.
        } else {
          await ffmpegQueue.add('postprocess', {
            generationId: generation.id,
            userId: generation.user_id,
            costCredits: generation.cost_credits,
            op: postprocessOp,
            inputR2Keys: [r2Key],
            audioR2Key,
            mediaType: 'video',
          });
          await deleteRawFaceUploads(generation); // SC1 — best-effort, clip is already archived
          console.log(`[webhook/replicate] postprocess (${postprocessOp}) queued for generation ${generation.id}`);
          res.status(200).json({ received: true, postprocess: postprocessOp });
          return;
        }
      }

      await markCompleted(generation.id, r2Key);
      await deleteRawFaceUploads(generation); // SC1 — best-effort, never throws past here

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
      const isTransient = payload.status === 'failed' && isTransientProviderError(payload.error);
      const isRetryable =
        generation.media_type === 'video' &&
        (SUPPORTED_MODELS as readonly string[]).includes(generation.model) &&
        generation.retry_count < 1;

      if (isTransient && isRetryable) {
        try {
          const retryInput = await buildRetryInput(generation);
          const { providerPredictionId } = await provider.dispatch(retryInput, getReplicateWebhookUrl());
          const reattached = await reattachForRetry(generation.id, providerPredictionId);
          if (reattached) {
            console.log(`[webhook/replicate] Transient failure retried: generation ${generation.id} redispatched as ${providerPredictionId}`);
            res.status(200).json({ received: true, retried: true });
            return;
          }
          // Guard didn't match (already retried or no longer processing) — another handler beat
          // us to it; treat as a duplicate rather than risk a second refund.
          res.status(200).json({ received: true, duplicate: true });
          return;
        } catch (retryError) {
          console.error(`[webhook/replicate] Retry dispatch failed for generation ${generation.id}:`, retryError);
          await markFailed(generation.id, 'provider_error');
          await refundCredits(generation.user_id, generation.cost_credits, payload.id);
          res.status(200).json({ received: true });
          return;
        }
      }

      const failureReason = isTransient ? 'provider_error' : classifyFailureReason(payload.error);

      // 09.3 D-02: Seedance content_policy block on an auto-picked model — fall back to the
      // permissive real-face/IP i2v catch-all (Grok 1.5) once, instead of failing+refunding.
      // Own prompt-moderation + the 9.2 input NSFW gate already ran BEFORE dispatch, so by the
      // time an E005/content_policy block returns here, it's a face/IP block, not NSFW — safe
      // to retry on a different, more permissive model (T-09.3-07).
      // NOTE (deviation, Rule 1): the plan's action text allows treating 'copyright' as eligible
      // too ("implement both as eligible"), but a pre-existing regression test predating this
      // plan — "does not retry a copyright failure even on a retryable model" (transient-failure
      // auto-retry describe, committed at 6374b2a, long before 09.3) — pins copyright failures to
      // ALWAYS fail+refund with no redispatch of any kind. Falling back copyright to Grok would
      // break that already-green regression guard, which the plan's own acceptance criteria
      // ("Transient auto-retry describe still passes") requires to keep passing. Scoped fallback
      // eligibility to content_policy only; copyright still always fails+refunds, unchanged.
      const generationParams = (generation.params ?? {}) as Record<string, unknown>;
      const modelExplicitlyPicked = generationParams.model_explicitly_picked === true;
      const isFallbackEligibleReason = failureReason === 'content_policy';
      const isFallbackEligible =
        isFallbackEligibleReason &&
        generation.media_type === 'video' &&
        (SUPPORTED_MODELS as readonly string[]).includes(generation.model) &&
        generation.retry_count < 1 &&
        !modelExplicitlyPicked;

      if (isFallbackEligible) {
        try {
          const retryInput = await buildRetryInput(generation);
          retryInput.model = PERMISSIVE_I2V_MODEL;
          const { providerPredictionId } = await provider.dispatch(retryInput, getReplicateWebhookUrl());
          const reattached = await reattachForRetry(generation.id, providerPredictionId);
          if (reattached) {
            console.log(`[webhook/replicate] ${failureReason} block on ${generation.model} — fell back to ${PERMISSIVE_I2V_MODEL} for generation ${generation.id} (${providerPredictionId})`);
            res.status(200).json({ received: true, fallback: 'grok' });
            return;
          }
          // Guard didn't match (already retried or no longer processing) — another handler beat
          // us to it; treat as a duplicate rather than risk a second refund.
          res.status(200).json({ received: true, duplicate: true });
          return;
        } catch (fallbackError) {
          console.error(`[webhook/replicate] Grok fallback dispatch failed for generation ${generation.id}:`, fallbackError);
          await markFailed(generation.id, 'provider_error');
          await refundCredits(generation.user_id, generation.cost_credits, payload.id);
          res.status(200).json({ received: true });
          return;
        }
      }

      const reason = failureReason;
      await markFailed(generation.id, reason);
      await refundCredits(generation.user_id, generation.cost_credits, payload.id);
      console.log(`[webhook/replicate] ${payload.status} (${reason}) raw error: ${JSON.stringify(payload.error)} — refunded ${generation.cost_credits} credits to user ${generation.user_id}`);
    } else {
      console.log(`[webhook/replicate] Unhandled status: ${payload.status}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook/replicate] Error processing webhook:', err);
    res.status(200).json({ received: true, error: 'internal_error' });
  }
});

