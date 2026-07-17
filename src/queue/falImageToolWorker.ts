// Background worker for blocking fal image tools. Provider URLs are archived to R2 immediately,
// then the existing CSAM gate runs before the generation can become visible to the client.

import { Worker, Job } from 'bullmq';
import { config } from '../config';
import { archiveToR2 } from '../services/archivalService';
import { refundCredits } from '../services/creditService';
import {
  classifyFailureReason,
  markCompleted,
  markFailed,
  markQuarantined,
} from '../services/generationService';
import { scanForCsam } from '../services/hiveService';
import { falRunImageBackgroundRemoval } from '../services/providers/FalProvider';
import { hiveScanQueue } from './hiveScanWorker';
import type { FalImageToolJob } from './falImageToolQueue';

const QUEUE_NAME = 'fal-image-tool';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export async function processFalImageTool(data: FalImageToolJob): Promise<void> {
  const { generationId, userId, cost } = data;

  let r2Key: string;
  try {
    const outputUrl = await falRunImageBackgroundRemoval(data.sourceImage);
    // Provider URLs expire. Archival is deliberately the first action after the fal call.
    r2Key = await archiveToR2(outputUrl, generationId, 'image/png');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[fal-image-tool] ${data.kind} failed for ${generationId}: ${errMsg}`);
    await markFailed(generationId, classifyFailureReason(errMsg));
    await refundCredits(userId, cost, `dispatch-failure-${generationId}`);
    return;
  }

  if (config.hiveScanEnabled) {
    try {
      const { flagged } = await scanForCsam(r2Key);
      if (flagged) {
        await markQuarantined(generationId);
        await refundCredits(userId, cost, `csam-quarantine-fal-image-${generationId}`);
        console.warn(`[fal-image-tool] CSAM flagged: generation ${generationId} quarantined`);
        return;
      }
    } catch (hiveErr) {
      console.error(`[fal-image-tool] Hive scan error for ${generationId} — queuing retry:`, hiveErr);
      await hiveScanQueue.add('scan', {
        generationId,
        r2Key,
        userId,
        costCredits: cost,
        mediaType: 'image',
      });
      return;
    }
  }

  await markCompleted(generationId, r2Key);
  console.log(`[fal-image-tool] ${data.kind} completed for ${generationId}`);
}

export const falImageToolWorker = new Worker<FalImageToolJob>(
  QUEUE_NAME,
  (job: Job<FalImageToolJob>) => processFalImageTool(job.data),
  { connection: connectionOptions, concurrency: 5 },
);

falImageToolWorker.on('failed', (job, err) => {
  console.error(`[fal-image-tool] Job ${job?.id} failed unexpectedly:`, err);
});
