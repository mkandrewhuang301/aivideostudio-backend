// BullMQ queue for short blocking fal image tools. The route returns `processing` immediately;
// falImageToolWorker archives the expiring provider output before completion is exposed.

import { Queue } from 'bullmq';

const QUEUE_NAME = 'fal-image-tool';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface FalImageToolJob {
  kind: 'remove-background';
  generationId: string;
  userId: string;
  cost: number;
  sourceImage: string;
}

export const falImageToolQueue = new Queue<FalImageToolJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});
