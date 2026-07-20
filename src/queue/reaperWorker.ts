// src/queue/reaperWorker.ts
// BullMQ repeatable job (every 5 min) — reaps orphaned (pending >5min) and stalled
// (processing >30min) generations. Uses BullMQ, not node-cron, per RESEARCH.md (Redis-persisted
// schedule survives restarts; reuses existing BullMQ/Redis infra from Phase 1).
// RESEARCH.md Pitfall 2: reuse generationService's atomic guarded-UPDATE functions (markRefunded/
// markCompleted) — NEVER a separate raw UPDATE — to avoid a double-refund/double-complete race
// with the webhook handler (Plan 04-04).

import { Queue, Worker } from 'bullmq';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { markRefunded, markCompleted } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { archiveToR2 } from '../services/archivalService';
import { scanForCsam } from '../services/hiveService';
import { enforceFlaggedGeneration } from '../services/moderationEnforcementService';
import { ReplicateProvider } from '../services/providers/ReplicateProvider';
import {
  FalProvider,
  falVideoOutputContentType,
  isFalAsyncVideoModel,
} from '../services/providers/FalProvider';
import { config } from '../config';
import { hiveScanQueue } from './hiveScanWorker';

const QUEUE_NAME = 'generation-reaper';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export const reaperQueue = new Queue(QUEUE_NAME, { connection: connectionOptions });

const replicateProvider = new ReplicateProvider();
const falProvider = new FalProvider();

function providerFor(model: string) {
  return isFalAsyncVideoModel(model) ? falProvider : replicateProvider;
}

interface ReapableRow {
  id: string;
  user_id: string;
  cost_credits: number;
  replicate_prediction_id: string | null;
  model: string;
  has_real_face_input: boolean;
}

export async function reapOrphanedJobs(): Promise<void> {
  const result = await db.execute(sql`
    SELECT id, user_id, cost_credits, replicate_prediction_id
    FROM generations
    WHERE status = 'pending' AND created_at < now() - interval '5 minutes'
      -- Explainer is a queued, multi-stage Omni pipeline and may legitimately wait/run far
      -- longer; non-format rows retain the original five-minute orphan window byte-for-byte.
      AND (media_type != 'format' OR created_at < now() - interval '90 minutes')
  `);

  for (const row of (result.rows ?? []) as unknown as ReapableRow[]) {
    const refunded = await markRefunded(row.id);
    if (refunded) {
      await refundCredits(row.user_id, row.cost_credits, row.replicate_prediction_id ?? row.id);
      console.log(`[reaper] Orphaned generation ${row.id} refunded ${row.cost_credits} credits`);
    }
  }
}

export async function reapStalledJobs(): Promise<void> {
  const result = await db.execute(sql`
    SELECT id, user_id, cost_credits, replicate_prediction_id, model, has_real_face_input
    FROM generations
    WHERE status = 'processing' AND created_at < now() - interval '30 minutes'
      -- Explainer's sequential TTS/stills/vision/Omni stages can exceed 30 minutes; non-format
      -- rows retain the original stalled-job window byte-for-byte.
      AND (media_type != 'format' OR created_at < now() - interval '90 minutes')
  `);

  for (const row of (result.rows ?? []) as unknown as ReapableRow[]) {
    if (!row.replicate_prediction_id) {
      const refunded = await markRefunded(row.id);
      if (refunded) await refundCredits(row.user_id, row.cost_credits, row.id);
      continue;
    }

    try {
      const prediction = await providerFor(row.model).getStatus(row.replicate_prediction_id);

      if (prediction.status === 'succeeded' && prediction.outputUrl) {
        const r2Key = await archiveToR2(
          prediction.outputUrl,
          row.id,
          isFalAsyncVideoModel(row.model) ? falVideoOutputContentType(row.model) : 'video/mp4',
        );

        if (config.hiveScanRealFacePaths && row.has_real_face_input) {
          try {
            const result = await scanForCsam(r2Key);
            if (result.flagged) {
              await enforceFlaggedGeneration(
                {
                  generationId: row.id,
                  r2Key,
                  userId: row.user_id,
                  costCredits: row.cost_credits,
                },
                result,
              );
              continue;
            }
          } catch (hiveErr) {
            console.error(`[reaper] Hive scan failed for ${row.id} — queuing retry:`, hiveErr);
            await hiveScanQueue.add('scan', {
              generationId: row.id,
              r2Key,
              userId: row.user_id,
              costCredits: row.cost_credits,
              mediaType: 'video',
            });
            continue;
          }
        }
        await markCompleted(row.id, r2Key);
        console.log(`[reaper] Stalled generation ${row.id} reconciled as completed`);
      } else if (prediction.status === 'failed' || prediction.status === 'canceled') {
        const refunded = await markRefunded(row.id);
        if (refunded) await refundCredits(row.user_id, row.cost_credits, row.replicate_prediction_id);
        console.log(`[reaper] Stalled generation ${row.id} reconciled as ${prediction.status}, refunded`);
      } else {
        console.log(`[reaper] Stalled generation ${row.id} still ${prediction.status}; leaving as-is`);
      }
    } catch (err) {
      console.error(`[reaper] Error reconciling stalled generation ${row.id}:`, err);
      const refunded = await markRefunded(row.id);
      if (refunded) await refundCredits(row.user_id, row.cost_credits, row.replicate_prediction_id ?? row.id);
    }
  }
}

export async function scheduleReaper(): Promise<void> {
  await reaperQueue.add(
    'reap',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'reaper-singleton' },
  );
}

export const reaperWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await reapOrphanedJobs();
    await reapStalledJobs();
  },
  { connection: connectionOptions, concurrency: 1 },
);
