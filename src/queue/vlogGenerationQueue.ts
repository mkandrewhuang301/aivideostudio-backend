// BullMQ queue for the character-vlog ONE-SHOT pipeline (v1, 2026-07-25 lock — the 7/24
// multi-take planner shape is shelved). One queue, two modes: 'create' runs expansion →
// qwen voice clone → one Mini clip → direct completion; 'regen' re-films the single persisted
// take (per-take billing — cost carries only that take's seconds so the failure path refunds
// the right amount).

import { Queue } from 'bullmq';

const QUEUE_NAME = 'vlog-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export type VlogGenerationJob =
  | {
      mode: 'create';
      generationId: string;
      userId: string;
      /** Full upfront cost (clip seconds) — refunded whole on any failure. */
      cost: number;
      characterId: string;
      beat: string;
      durationSeconds: number;
    }
  | {
      mode: 'regen';
      generationId: string;
      userId: string;
      /** This take's seconds only — refunded on regen failure. */
      cost: number;
      takeIndex: number;
    };

export const vlogGenerationQueue = new Queue<VlogGenerationJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1, // worker owns the refund on failure; no BullMQ retry storm (explainer precedent)
    removeOnComplete: true,
    removeOnFail: true,
  },
});
