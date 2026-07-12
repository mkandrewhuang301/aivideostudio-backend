// src/queue/chainGenerationWorker.ts
// Background worker for the chained-job primitive (09.6, D-01/D-05) — sole 9.6 consumer is You vs
// You (UVU). Stage 1 composes N keyframe(s) from the user's photo(s) via generateKeyframeFromPhotos
// (Wan 2.7 Image, synchronous replicate.run() in ReplicateProvider.ts). Stage 2 dispatches
// HappyHorse 1.1 with the keyframe(s) as its `images` reference array and attaches the resulting
// prediction id to the SAME generation row — the existing webhook then archives the clip and,
// because the row carries a `postprocess: mux` stamp, enqueues the ffmpeg mux worker. No
// intermediate still approval (D-05).
//
// Mirrors src/queue/openaiGenerationWorker.ts's BullMQ pattern: try -> Stage1 -> Stage2 ->
// attachPredictionId (no markCompleted here — that only happens via the webhook after a real clip
// archives); catch -> markFailed + refundCredits. Never a retry storm (attempts: 1).

import { Worker, Job } from 'bullmq';
import { generateKeyframeFromPhotos, ReplicateProvider } from '../services/providers/ReplicateProvider';
import { getGenerationPresignedUrl } from '../services/archivalService';
import { attachPredictionId, markFailed, classifyFailureReason } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { getReplicateWebhookUrl } from '../config';
import type { GenerationInput } from '../services/providers/ModelProvider';
import type { ChainGenerationJob } from './chainGenerationQueue';

const QUEUE_NAME = 'chain-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

const provider = new ReplicateProvider();

// Exported for testing — the BullMQ Worker below just calls this with job.data.
export async function processChainGeneration(data: ChainGenerationJob): Promise<void> {
  try {
    // Stage 1: compose one keyframe per image_stage prompt (UVU = 2: current-you arena walk-in,
    // young-you spotlight reveal). Distinct R2 keys per keyframe index — never overwrite.
    const keyframeUrls: string[] = [];
    for (let i = 0; i < data.imageStage.prompts.length; i++) {
      const r2Key = await generateKeyframeFromPhotos(
        data.userPhotoUrls,
        data.imageStage.prompts[i]!,
        `${data.generationId}.keyframe${i}`,
      );
      keyframeUrls.push(await getGenerationPresignedUrl(r2Key));
    }

    // Stage 2: HappyHorse animates with ALL keyframes in its `images` reference array + a
    // choreography prompt naming which image is the opening vs. the ending reveal.
    const input: GenerationInput = {
      prompt: data.animateStage.prompt_template,
      model: data.animateStage.model,
      mediaType: 'video',
      referenceImages: keyframeUrls,
      durationSeconds: data.animateStage.duration,
      resolution: data.animateStage.resolution,
      aspectRatio: data.animateStage.aspect_ratio,
      audioEnabled: true,
    };

    const { providerPredictionId } = await provider.dispatch(input, getReplicateWebhookUrl());
    await attachPredictionId(data.generationId, providerPredictionId);
    console.log(`[chain-generation] Stage 2 dispatched for ${data.generationId} (prediction ${providerPredictionId})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[chain-generation] chain dispatch failed for ${data.generationId}: ${errMsg}`);
    await markFailed(data.generationId, classifyFailureReason(errMsg));
    await refundCredits(data.userId, data.cost, `chain-failure-${data.generationId}`);
  }
}

export const chainGenerationWorker = new Worker<ChainGenerationJob>(
  QUEUE_NAME,
  (job: Job<ChainGenerationJob>) => processChainGeneration(job.data),
  { connection: connectionOptions, concurrency: 5 },
);

chainGenerationWorker.on('failed', (job, err) => {
  console.error(`[chain-generation] Job ${job?.id} failed unexpectedly:`, err);
});
