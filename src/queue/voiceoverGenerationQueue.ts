// src/queue/voiceoverGenerationQueue.ts
// Placeholder queue for standalone AI Voiceover generation. The worker implementation
// (provider dispatch, R2 archival, completion) is built in the next plan; this queue
// exists now so the route can attempt enqueue and fail-safe refund on queue errors.

import { Queue } from 'bullmq';
import { config } from '../config';

export const voiceoverGenerationQueue = new Queue('voiceover-generation', {
  connection: { url: config.redisUrl, maxRetriesPerRequest: null },
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
});
