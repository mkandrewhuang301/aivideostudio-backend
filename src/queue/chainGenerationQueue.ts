// src/queue/chainGenerationQueue.ts
// BullMQ queue for the chained-job primitive (09.6, D-01/D-05) — sole 9.6 consumer is You vs You
// (UVU): Stage 1 composes N keyframe(s) via generateKeyframeFromPhotos (Wan 2.7 Image, synchronous
// replicate.run()), Stage 2 dispatches HappyHorse 1.1 with the keyframe(s) as its `images`
// reference array, attaching the prediction id to the SAME generation row. The existing webhook
// then archives the clip and — because the row carries a `postprocess: mux` stamp — enqueues the
// ffmpeg mux worker. Mirrors openaiGenerationQueue.ts's shape exactly.

import { Queue } from 'bullmq';

const QUEUE_NAME = 'chain-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface ChainGenerationJob {
  generationId: string;
  userId: string;
  cost: number;
  userPhotoUrls: string[];
  imageStage: { model: string; quality: 'high' | 'medium' | 'low'; prompts: string[] };
  animateStage: { model: string; resolution: '720p' | '1080p'; duration: number; aspect_ratio: string; prompt_template: string };
}

export const chainGenerationQueue = new Queue<ChainGenerationJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1, // no BullMQ-level retry — worker handles failure via markFailed + refund
    removeOnComplete: true,
    removeOnFail: true,
  },
});
