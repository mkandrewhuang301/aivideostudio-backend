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
      // The scan already ran the OpenAI call and produced r2Key — do NOT leave the row pending
      // waiting on a scan retry queue that doesn't exist for this path; log and complete, same
      // as any other best-effort Hive failure elsewhere in the codebase.
      console.error(`[openai-generation] Hive scan error for ${generationId} — completing without retry:`, hiveErr);
      await markCompleted(generationId, r2Key);
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
