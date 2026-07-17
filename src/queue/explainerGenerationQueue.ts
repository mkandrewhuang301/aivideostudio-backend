// BullMQ queue for the server-driven Explainer format pipeline. The worker re-reads FormatDef
// from FORMATS_BY_ID so Redis carries only validated ids and primitives, never stale descriptors.

import { Queue } from 'bullmq';

const QUEUE_NAME = 'explainer-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface ExplainerAttachment {
  r2Key: string;
  mimeType: string;
}

export interface ExplainerGenerationJob {
  generationId: string;
  userId: string;
  cost: number;
  formatId: string;
  topic: string;
  styleId: string;
  voiceId: string;
  music: string;
  sceneCount: number;
  durationSeconds: number;
  aspectRatio: string;
  attachments: ExplainerAttachment[];
  sourceUrl: string | null;
}

export const explainerGenerationQueue = new Queue<ExplainerGenerationJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1, // worker owns one full-price refund on failure; no BullMQ retry storm
    removeOnComplete: true,
    removeOnFail: true,
  },
});
