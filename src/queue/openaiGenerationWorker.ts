// src/queue/openaiGenerationWorker.ts
// Background worker for the two inline OpenAI presets (faceswap + Magic Editor). Runs the OpenAI
// call (generateFaceswap / generateImageEditWithMask) that USED to happen synchronously inside
// POST /api/generations — moved here (D-C) so the route can return `processing` immediately and
// never block the HTTP request for the ~47s the OpenAI edit takes.
//
// Mirrors src/queue/hiveScanWorker.ts's BullMQ pattern. Never sends an HTTP response — only
// updates the generation row; the client polls via the existing GET /api/generations machinery.
//
// D-E: faceswap uploaded photos are RETAINED (this worker never reaps raw uploads) so Remix can
// prefill them — the standard 24h uploadReaperWorker handles eventual cleanup instead.

import { Worker, Job } from 'bullmq';
import { config } from '../config';
import { generateFaceswap, generateImageEditWithMask } from '../services/openaiImageService';
import { markCompleted, markFailed, markQuarantined, classifyFailureReason } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { scanForCsam } from '../services/hiveService';
import { hiveScanQueue } from './hiveScanWorker';
import type { OpenAIGenerationJob } from './openaiGenerationQueue';

const QUEUE_NAME = 'openai-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

// Exported for testing — the BullMQ Worker below just calls this with job.data.
export async function processOpenAIGeneration(data: OpenAIGenerationJob): Promise<void> {
  const { generationId, userId, cost } = data;

  let r2Key: string;
  try {
    r2Key =
      data.kind === 'faceswap'
        ? await generateFaceswap(data.targetImage, data.faceImage, generationId)
        : await generateImageEditWithMask(data.sourceImage, data.maskUrl, data.prompt, generationId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[openai-generation] ${data.kind} dispatch failed for ${generationId}: ${errMsg}`);
    await markFailed(generationId, classifyFailureReason(errMsg));
    await refundCredits(userId, cost, `dispatch-failure-${generationId}`);
    return;
  }

  // CSAM scan (only when enabled) — mirrors the webhook success path (routes/webhooks/replicate.ts).
  if (config.hiveScanEnabled) {
    try {
      const { flagged } = await scanForCsam(r2Key);
      if (flagged) {
        await markQuarantined(generationId);
        await refundCredits(userId, cost, `csam-quarantine-openai-${generationId}`);
        console.warn(`[openai-generation] CSAM flagged: generation ${generationId} quarantined`);
        return;
      }
    } catch (hiveErr) {
      // FIX (2026-07-12): this used to mark the row completed on any Hive error, shipping
      // unscanned content — CLAUDE.md Rule 4 violation. hiveScanQueue (hiveScanWorker.ts) is a
      // generic, media-type-agnostic retry queue that already exists for exactly this — the
      // Replicate webhook path (webhooks/replicate.ts) already routes Hive errors through it.
      // Mirror that here instead of completing without a scan.
      console.error(`[openai-generation] Hive scan error for ${generationId} — queuing retry:`, hiveErr);
      await hiveScanQueue.add('scan', {
        generationId,
        r2Key,
        userId,
        costCredits: cost,
        mediaType: 'image', // both faceswap and magic-editor are image edits
      });
      console.log(`[openai-generation] Hive retry queued for generation ${generationId}`);
      return;
    }
  }

  await markCompleted(generationId, r2Key);
  console.log(`[openai-generation] ${data.kind} completed for ${generationId}`);
}

export const openaiGenerationWorker = new Worker<OpenAIGenerationJob>(
  QUEUE_NAME,
  (job: Job<OpenAIGenerationJob>) => processOpenAIGeneration(job.data),
  { connection: connectionOptions, concurrency: 5 },
);

openaiGenerationWorker.on('failed', (job, err) => {
  console.error(`[openai-generation] Job ${job?.id} failed unexpectedly:`, err);
});
