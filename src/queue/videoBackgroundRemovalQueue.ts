// src/queue/videoBackgroundRemovalQueue.ts
// Video Background Removal queue + worker. Dispatches Bria VRMBG 3.0 via fal, archives the output
// to R2 as the FIRST post-result action (CLAUDE.md rule #2 — provider URLs expire, never
// store/serve one), swaps the source clip's media to the R2 key, and refunds exactly once on
// failure via a Redis NX guard (CLAUDE.md rule #5 idiom). Closest analog:
// audioSeparationQueue.ts, whose Queue+Worker+on('failed') skeleton is copied.

import { Job, Queue, Worker } from 'bullmq';
import { config } from '../config';
import { getGenerationPresignedUrl, uploadBufferToR2 } from '../services/archivalService';
import {
  applyBackgroundRemovalToClip,
  completeBgRemoval,
  getBgRemovalJob,
  markBgRemovalProcessing,
  refundBgRemoval,
  resolveOutputExtension,
  verifyClipOwnership,
  VideoBgRemovalNotFoundError,
} from '../services/videoBackgroundRemovalService';
import {
  falBriaBackgroundRemovalProvider,
  VideoBackgroundRemovalProviderError,
} from '../services/providers/FalBriaBackgroundRemovalProvider';
import type {
  BackgroundColor,
  VideoBackgroundRemovalResult,
} from '../services/providers/VideoBackgroundRemovalProvider';
import { redis } from '../redis/client';

const QUEUE_NAME = 'video-background-removal';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface VideoBackgroundRemovalJobPayload {
  jobId: string;
}

export const videoBackgroundRemovalQueue = new Queue<VideoBackgroundRemovalJobPayload>(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: true,
  },
});

export async function processVideoBackgroundRemoval(
  job: Job<VideoBackgroundRemovalJobPayload>,
): Promise<void> {
  const id = job.data.jobId;
  // Idempotent re-run guard: markBgRemovalProcessing returns null on a race (already
  // processing/terminal) — re-fetch and short-circuit on a terminal status.
  let row = await markBgRemovalProcessing(id);
  if (!row) row = await getBgRemovalJob(id);
  if (!row || row.status === 'completed' || row.status === 'refunded') return;

  // Re-read the source through the ownership-scoped path so a clip deleted between enqueue and
  // execution fails non-retryably instead of burning all three attempts.
  let sourceR2Key: string;
  try {
    const clip = await verifyClipOwnership(row.source_clip_id, row.user_id);
    sourceR2Key = clip.r2_key;
  } catch (error) {
    if (error instanceof VideoBgRemovalNotFoundError) {
      job.discard();
      throw new VideoBackgroundRemovalProviderError(
        'Source clip no longer exists',
        false,
        'source_missing',
      );
    }
    throw error;
  }

  // The WHOLE source clip is processed, not the trimmed window — see the timebase-preservation
  // rationale in videoBackgroundRemovalService.ts's header. This is also exactly what was billed.
  const videoUrl = await getGenerationPresignedUrl(sourceR2Key);

  let result: VideoBackgroundRemovalResult;
  try {
    result = await falBriaBackgroundRemovalProvider.removeBackground({
      model: row.model,
      videoUrl,
      backgroundColor: row.background_color as BackgroundColor,
      // Persisted at create time, derived from the background (never client-chosen) so a retry
      // cannot silently switch containers mid-flight.
      outputContainerAndCodec: row.output_container_and_codec,
      preserveAudio: true,
      durationSeconds: row.duration_seconds,
    });
  } catch (error) {
    if (error instanceof VideoBackgroundRemovalProviderError && !error.retryable) job.discard();
    throw error;
  }

  // FIRST post-result action (CLAUDE.md rule #2): archive to R2 before ANY DB write. Bria's output
  // URL is never stored or served to any client — only this R2 key is.
  const extension = resolveOutputExtension(row.output_container_and_codec);
  const outputKey = `video-background-removal/${id}/output.${extension}`;
  await uploadBufferToR2(result.video, outputKey, result.mimeType);

  await applyBackgroundRemovalToClip({ job: row, outputR2Key: outputKey });

  await completeBgRemoval({
    id,
    providerRequestId: result.providerRequestId,
    outputR2Key: outputKey,
  });
}

export const videoBackgroundRemovalWorker = new Worker<VideoBackgroundRemovalJobPayload>(
  QUEUE_NAME,
  processVideoBackgroundRemoval,
  {
    connection,
    concurrency: Math.max(1, config.videoBgRemovalWorkerConcurrency),
    limiter: { max: Math.max(1, config.videoBgRemovalRequestsPerMinute), duration: 60_000 },
  },
);

videoBackgroundRemovalWorker.on('failed', async (job, error) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  // Redis NX guard (CLAUDE.md rule #5 idiom): a BullMQ retry storm or a duplicate 'failed' event
  // fire can never double-refund the same job.
  const key = `video_bg_refund:${job.data.jobId}`;
  const isNew = await redis.set(key, '1', 'EX', 604800, 'NX');
  if (!isNew) return;
  const providerError = error instanceof VideoBackgroundRemovalProviderError ? error : undefined;
  await refundBgRemoval(
    job.data.jobId,
    providerError?.code ?? 'generation_failed',
    providerError?.retryable
      ? 'Background removal failed after retries'
      : 'Background removal was rejected',
  ).catch((refundError) => console.error('[video-bg] refund failed', refundError));
});
