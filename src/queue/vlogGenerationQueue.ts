// BullMQ queue for the character-vlog multi-take pipeline (gorilla, 2026-07-24 spec).
// One queue, two modes: 'plan' runs the full planner → N takes → concat pipeline; 'regen'
// re-films ONE persisted take and re-stitches (per-take billing — cost carries only that
// take's seconds so the ffmpeg timeout-refund path refunds the right amount).

import { Queue } from 'bullmq';

const QUEUE_NAME = 'vlog-generation';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export type VlogGenerationJob =
  | {
      mode: 'plan';
      generationId: string;
      userId: string;
      /** Full upfront cost (total seconds) — refunded whole on any failure. */
      cost: number;
      characterId: string;
      topic: string;
      vibe?: string;
      totalSeconds: number;
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
