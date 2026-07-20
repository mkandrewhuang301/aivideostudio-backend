import { Job, Queue, Worker } from 'bullmq';
import { reportGenerationToNcmec } from '../services/ncmecReportService';

const QUEUE_NAME = 'ncmec-report';
// Exponential 1-minute backoff across 10 attempts exhausts in under 9 hours, leaving time for
// the documented manual fallback inside the 24-hour operational deadline.
export const NCMEC_REPORT_ATTEMPTS = 10;

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export interface NcmecReportJobData { generationId: string }

export const ncmecReportQueue = new Queue<NcmecReportJobData>(QUEUE_NAME, {
  connection: connectionOptions,
  defaultJobOptions: {
    attempts: NCMEC_REPORT_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export async function processNcmecReport(data: NcmecReportJobData): Promise<void> {
  const reportId = await reportGenerationToNcmec(data.generationId);
  console.log(`[ncmec-report] CyberTipline report ${reportId} finished for generation ${data.generationId}`);
}

export const ncmecReportWorker = new Worker<NcmecReportJobData>(
  QUEUE_NAME,
  (job: Job<NcmecReportJobData>) => processNcmecReport(job.data),
  { connection: connectionOptions, concurrency: 1 },
);

ncmecReportWorker.on('failed', (job, error) => {
  const final = !!job && job.attemptsMade >= NCMEC_REPORT_ATTEMPTS;
  console.error(
    `[ncmec-report] ${final ? 'ALERT: FINAL FAILURE' : 'retrying'} for generation ${job?.data.generationId ?? 'unknown'} — manual Hive-dashboard filing is required if retries exhaust:`,
    error,
  );
});
