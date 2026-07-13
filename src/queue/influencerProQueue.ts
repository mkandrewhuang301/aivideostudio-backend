// src/queue/influencerProQueue.ts
// BullMQ queue for AI Influencer's Pro tier (character_replace_quality: 'pro') — a 3-step
// pipeline run in influencerProWorker.ts: ffmpeg frame extract -> Wan 2.7 Image composite ->
// Kling v3 Motion Control, attaching the final prediction id to the SAME generation row the
// existing webhook already knows how to archive/complete. Mirrors chainGenerationQueue.ts's shape.

import { Queue } from 'bullmq';

const QUEUE_NAME = 'influencer-pro-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface InfluencerProGenerationJob {
  generationId: string;
  userId: string;
  cost: number;
  characterImageUrl: string; // presigned URL — user's uploaded character photo
  sourceVideoUrl: string;    // presigned URL — user's uploaded video (motion/background source)
}

export const influencerProQueue = new Queue<InfluencerProGenerationJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1, // no BullMQ-level retry — worker handles failure via markFailed + refund
    removeOnComplete: true,
    removeOnFail: true,
  },
});
