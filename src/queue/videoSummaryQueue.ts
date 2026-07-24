import { Queue } from 'bullmq';
import type { VideoSummaryMode } from '../services/videoSummaryService';

const QUEUE_NAME = 'video-summary';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface VideoSummaryJob {
  generationId: string;
  userId: string;
  cost: number;
  sourceR2Key: string;
  sourceMimeType: string;
  sourceDurationSeconds: number;
  mode: VideoSummaryMode;
  theme: string | null;
  context: string | null;
  outputDurationSeconds: number;
  aspectRatio: '1:1' | '9:16' | '16:9';
  voiceId: string;
  includeMusic: boolean;
}

export const videoSummaryQueue = new Queue<VideoSummaryJob>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});
