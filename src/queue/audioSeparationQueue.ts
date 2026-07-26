// src/queue/audioSeparationQueue.ts
// Audio Separation queue + worker. Dispatches fal SAM Audio, archives BOTH stems to R2 as the
// FIRST post-result action (CLAUDE.md rule #2 — provider URLs expire, never store/serve one),
// persists the stems as project_audio_clips rows via attachSeparationStems, and refunds exactly
// once on failure via a Redis NX guard (CLAUDE.md rule #5 idiom). Closest analog:
// soundtrackGenerationQueue.ts (full Queue+Worker+on('failed') skeleton copied).

import { Job, Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { projectClips } from '../db/schema';
import { getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import {
  attachSeparationStems,
  completeAudioSeparation,
  getAudioSeparationJob,
  markAudioSeparationProcessing,
  refundAudioSeparation,
} from '../services/audioSeparationService';
import {
  AudioSeparationProviderError,
  falSamAudioProvider,
} from '../services/providers/FalSamAudioProvider';
import type { AudioSeparationResult } from '../services/providers/AudioSeparationProvider';
import { redis } from '../redis/client';

const QUEUE_NAME = 'audio-separation';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface AudioSeparationJobPayload {
  jobId: string;
}

export const audioSeparationQueue = new Queue<AudioSeparationJobPayload>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export async function processAudioSeparation(job: Job<AudioSeparationJobPayload>): Promise<void> {
  const id = job.data.jobId;
  // Idempotent re-run guard: markAudioSeparationProcessing returns null on a race (already
  // processing/terminal) — re-fetch and short-circuit on a terminal status, matching
  // soundtrackGenerationQueue.ts's exact shape.
  let row = await markAudioSeparationProcessing(id);
  if (!row) row = await getAudioSeparationJob(id);
  if (!row || row.status === 'completed' || row.status === 'refunded') return;

  const [sourceClip] = await db
    .select({ r2_key: projectClips.r2_key })
    .from(projectClips)
    .where(eq(projectClips.id, row.source_clip_id));
  if (!sourceClip) {
    // Source clip is gone (hard-purged past the soft-delete window) — nothing to separate;
    // non-retryable, so stop burning attempts and let on('failed') refund.
    job.discard();
    throw new AudioSeparationProviderError('Source clip no longer exists', false, 'source_missing');
  }
  const audioUrl = await getGenerationPresignedUrl(sourceClip.r2_key);

  let result: AudioSeparationResult;
  try {
    result = await falSamAudioProvider.separate({
      model: row.model,
      audioUrl,
      prompt: row.prompt,
      durationSeconds: row.duration_seconds,
    });
  } catch (error) {
    if (error instanceof AudioSeparationProviderError && !error.retryable) job.discard();
    throw error;
  }

  // FIRST post-result action (CLAUDE.md rule #2): archive BOTH stems to R2 before ANY DB write.
  // fal's target/residual URLs are never stored or served to any client — only these R2 keys are.
  const targetKey = `audio-separation/${id}/target.mp3`;
  const residualKey = `audio-separation/${id}/residual.mp3`;
  await uploadBufferToR2(result.target, targetKey, result.mimeType);
  await uploadBufferToR2(result.residual, residualKey, result.mimeType);

  const stems = await attachSeparationStems({
    job: row,
    targetR2Key: targetKey,
    residualR2Key: residualKey,
    residualLabel: 'Everything else',
    targetLabel: row.prompt,
  });

  await completeAudioSeparation({
    id,
    providerRequestId: result.providerRequestId,
    targetR2Key: targetKey,
    residualR2Key: residualKey,
    targetClipId: stems.targetClipId,
    residualClipId: stems.residualClipId,
  });
}

export const audioSeparationWorker = new Worker<AudioSeparationJobPayload>(
  QUEUE_NAME,
  processAudioSeparation,
  {
    connection,
    concurrency: Math.max(1, config.audioSepWorkerConcurrency),
    limiter: { max: Math.max(1, config.audioSepRequestsPerMinute), duration: 60_000 },
  },
);

audioSeparationWorker.on('failed', async (job, error) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  // Redis NX guard (CLAUDE.md rule #5 idiom, revenuecat.ts:112-113): a BullMQ retry storm or a
  // duplicate 'failed' event fire can never double-refund the same job.
  const key = `audio_sep_refund:${job.data.jobId}`;
  const isNew = await redis.set(key, '1', 'EX', 604800, 'NX');
  if (!isNew) return;
  const providerError = error instanceof AudioSeparationProviderError ? error : undefined;
  await refundAudioSeparation(
    job.data.jobId,
    providerError?.code ?? 'generation_failed',
    providerError?.retryable ? 'Separation failed after retries' : 'Separation was rejected',
  ).catch((refundError) => console.error('[audio-sep] refund failed', refundError));
});
