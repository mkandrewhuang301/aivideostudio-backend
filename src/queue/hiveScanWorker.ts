// src/queue/hiveScanWorker.ts
// Retries the Hive CSAM scan for generations where the scan errored in the webhook handler.
// The video is already archived to R2 — we only retry the scan, never re-dispatch to Replicate.
// 6 attempts × 10s fixed backoff ≈ 60s total window before giving up.
// On final failure: markFailed + refund credits.

import { Queue, Worker, Job } from 'bullmq';
import { markCompleted, markFailed, markQuarantined } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { scanForCsam } from '../services/hiveService';
import { sendGenerationComplete } from '../services/apnsService';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';

const QUEUE_NAME = 'hive-scan-retry';
export const HIVE_SCAN_ATTEMPTS = 6;
const RETRY_DELAY_MS = 10_000;

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface HiveScanJobData {
  generationId: string;
  r2Key: string;
  userId: string;
  costCredits: number;
}

export const hiveScanQueue = new Queue<HiveScanJobData>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: HIVE_SCAN_ATTEMPTS,
    backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

// Exported for testing — BullMQ retries this automatically on throw.
export async function processHiveScan(data: HiveScanJobData): Promise<void> {
  const { generationId, r2Key, userId, costCredits } = data;

  // Throws on Hive API error — BullMQ catches and retries automatically.
  const { flagged } = await scanForCsam(r2Key);

  if (flagged) {
    await markQuarantined(generationId);
    await refundCredits(userId, costCredits, `csam-quarantine-${generationId}`);
    console.warn(`[hive-scan-retry] CSAM flagged: generation ${generationId} quarantined`);
    return;
  }

  const completed = await markCompleted(generationId, r2Key);
  if (completed) {
    try {
      const userRows = await db.execute(sql`SELECT apns_device_token FROM users WHERE id = ${userId}::uuid`);
      const token = (userRows.rows?.[0] as { apns_device_token: string | null } | undefined)?.apns_device_token;
      if (token) await sendGenerationComplete(token, generationId);
    } catch (pushErr) {
      console.error('[hive-scan-retry] Push notification failed (non-blocking):', pushErr);
    }
    console.log(`[hive-scan-retry] Generation ${generationId} completed after Hive retry`);
  }
}

// Exported for testing — called when all retry attempts are exhausted.
export async function handleScanFinalFailure(data: HiveScanJobData, err: Error): Promise<void> {
  const { generationId, userId, costCredits } = data;
  console.error(`[hive-scan-retry] All ${HIVE_SCAN_ATTEMPTS} attempts failed for ${generationId} — failing and refunding:`, err);
  await markFailed(generationId).catch((e) => console.error('[hive-scan-retry] markFailed error:', e));
  await refundCredits(userId, costCredits, `hive-timeout-${generationId}`).catch((e) =>
    console.error('[hive-scan-retry] refundCredits error:', e),
  );
}

export const hiveScanWorker = new Worker<HiveScanJobData>(
  QUEUE_NAME,
  (job: Job<HiveScanJobData>) => processHiveScan(job.data),
  { connection: connectionOptions, concurrency: 5 },
);

hiveScanWorker.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < HIVE_SCAN_ATTEMPTS) return;
  await handleScanFinalFailure(job.data, err);
});
