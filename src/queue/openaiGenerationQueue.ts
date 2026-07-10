// src/queue/openaiGenerationQueue.ts
// BullMQ queue for the two inline OpenAI presets (faceswap + Magic Editor). Both used to run
// SYNCHRONOUSLY inside the POST /api/generations request — fine in mocked tests, but gpt-image-2
// edits take ~47s in production, well past the client's HTTP timeout (~30s). This queue lets the
// route return `processing` immediately; openaiGenerationWorker.ts does the actual OpenAI call
// and updates the row in the background, same as every other async generation.

import { Queue } from 'bullmq';

const QUEUE_NAME = 'openai-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export type OpenAIGenerationJob =
  | {
      kind: 'faceswap';
      generationId: string;
      userId: string;
      cost: number;
      targetImage: string;
      faceImage: string;
    }
  | {
      kind: 'magic-editor';
      generationId: string;
      userId: string;
      cost: number;
      sourceImage: string;
      maskUrl: string;
      prompt: string;
    };

export const openaiGenerationQueue = new Queue<OpenAIGenerationJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1, // no BullMQ-level retry — worker handles failure via markFailed + refund
    removeOnComplete: true,
    removeOnFail: true,
  },
});
