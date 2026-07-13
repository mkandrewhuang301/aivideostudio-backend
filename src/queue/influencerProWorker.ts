// src/queue/influencerProWorker.ts
// Background worker for AI Influencer's Pro tier (character_replace_quality: 'pro') — 3 stages:
//   1. ffmpeg frame extract (frameExtractor.ts) — grabs a still from the user's own video at
//      ~0.5s in, giving Wan 2.7 a real background/lighting/pose reference to composite onto.
//   2. Wan 2.7 Image composite (generateKeyframeFromPhotos, ReplicateProvider.ts) — character
//      photo + extracted frame -> a single still with the character's identity swapped in,
//      original pose/lighting/background preserved.
//   3. Kling v3 Motion Control (ReplicateProvider.ts, standalone since Plan 09.6-03) — transfers
//      the ORIGINAL video's motion onto the composite still, character_orientation: 'video' (up
//      to 30s, matching the preset's existing max_seconds cap) so the output tracks the source
//      video's real duration rather than being capped at 10s. Uses Kling's 'std' mode (720p),
//      NOT 'pro' — this preset's "Pro" tier is the 3-step pipeline itself, not Kling's own
//      internal quality flag (2026-07-13, user-clarified); std keeps resolution parity with
//      Standard tier's existing 720p output and is the cheaper of Kling's two rates.
// Mirrors chainGenerationWorker.ts's shape: try -> stage 1 -> stage 2 -> stage 3 ->
// attachPredictionId (no markCompleted here — the existing Replicate webhook does that once Kling's
// prediction actually completes); catch -> markFailed + refundCredits. No retry storm (attempts: 1).

import { Worker, Job } from 'bullmq';
import { extractVideoFrame } from '../services/frameExtractor';
import { generateKeyframeFromPhotos, ReplicateProvider } from '../services/providers/ReplicateProvider';
import { getGenerationPresignedUrl } from '../services/archivalService';
import { attachPredictionId, markFailed, classifyFailureReason } from '../services/generationService';
import { refundCredits } from '../services/creditService';
import { getReplicateWebhookUrl } from '../config';
import type { GenerationInput } from '../services/providers/ModelProvider';
import type { InfluencerProGenerationJob } from './influencerProQueue';

const QUEUE_NAME = 'influencer-pro-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

const provider = new ReplicateProvider();

// Tested baseline prompt (user-verified 2026-07-12) — may be reworded later, but this is the
// known-working composite instruction. Never caller-supplied; this preset takes no text prompt
// (D-23's prompt_template is '' for ai-influencer, same as Standard tier).
const COMPOSITE_PROMPT =
  'Reference Image 1: [person] / Reference Image 2: [scene] / Please create a creative and ' +
  "artistic edit: Replace the main character in the second image with a person who has the " +
  'same appearance as the one in the first image. Keep the exact same pose, lighting, shadows, ' +
  "background, and composition as the original second image. Only change the character's " +
  'identity and facial features and hair and clothes to match the person in the first image. ' +
  'Make it look natural and well-lit. This is for artistic purposes only.';

// Exported for testing — the BullMQ Worker below just calls this with job.data.
export async function processInfluencerProGeneration(data: InfluencerProGenerationJob): Promise<void> {
  try {
    // Stage 1: ffmpeg frame extract from the user's own video.
    const frameR2Key = await extractVideoFrame(data.sourceVideoUrl, `${data.generationId}.frame`, 0.5);
    const frameUrl = await getGenerationPresignedUrl(frameR2Key);

    // Stage 2: Wan 2.7 Image composite (character photo + extracted frame).
    const compositeR2Key = await generateKeyframeFromPhotos(
      [data.characterImageUrl, frameUrl],
      COMPOSITE_PROMPT,
      `${data.generationId}.composite`,
    );
    const compositeUrl = await getGenerationPresignedUrl(compositeR2Key);

    // Stage 3: Kling v3 Motion Control — composite image + ORIGINAL video (not the extracted
    // frame) so the output actually tracks the source video's motion. mediaType deliberately
    // 'video' (not 'character_replace') — ReplicateProvider.ts branches on mediaType BEFORE its
    // model-id checks, and 'character_replace' would misroute this into the Wan 2.2 Animate
    // Replace payload shape instead of Kling's. The generation ROW's own media_type stays
    // 'character_replace' (stamped at creation in generations.ts) so the client renders it
    // identically to Standard tier — this mediaType only controls provider dispatch shape.
    const input: GenerationInput = {
      prompt: '',
      model: 'kwaivgi/kling-v3-motion-control',
      mediaType: 'video',
      klingMotionImage: compositeUrl,
      klingMotionVideo: data.sourceVideoUrl,
      klingMotionMode: 'std',
      klingMotionCharacterOrientation: 'video',
      klingMotionKeepOriginalSound: true,
    };

    const { providerPredictionId } = await provider.dispatch(input, getReplicateWebhookUrl());
    await attachPredictionId(data.generationId, providerPredictionId);
    console.log(`[influencer-pro] Stage 3 dispatched for ${data.generationId} (prediction ${providerPredictionId})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[influencer-pro] pipeline failed for ${data.generationId}: ${errMsg}`);
    await markFailed(data.generationId, classifyFailureReason(errMsg));
    await refundCredits(data.userId, data.cost, `influencer-pro-failure-${data.generationId}`);
  }
}

export const influencerProWorker = new Worker<InfluencerProGenerationJob>(
  QUEUE_NAME,
  (job: Job<InfluencerProGenerationJob>) => processInfluencerProGeneration(job.data),
  { connection: connectionOptions, concurrency: 5 },
);

influencerProWorker.on('failed', (job, err) => {
  console.error(`[influencer-pro] Job ${job?.id} failed unexpectedly:`, err);
});
