import { Queue, Worker } from 'bullmq';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db/client';
import { projectSoundtrackGenerations } from '../db/schema';
import { refundSoundtrack } from '../services/soundtrackService';
import { soundtrackGenerationQueue } from './soundtrackGenerationQueue';

const QUEUE_NAME = 'ai-soundtrack-reaper';
const connection = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export const soundtrackReaperQueue = new Queue(QUEUE_NAME, { connection });

export async function reapStaleSoundtracks(now = new Date()): Promise<void> {
  const pendingCutoff = new Date(now.getTime() - 5 * 60_000);
  const processingCutoff = new Date(now.getTime() - 15 * 60_000);
  const rows = await db.select().from(projectSoundtrackGenerations).where(or(
    and(
      eq(projectSoundtrackGenerations.status, 'pending'),
      lt(projectSoundtrackGenerations.created_at, pendingCutoff),
    ),
    and(
      eq(projectSoundtrackGenerations.status, 'processing'),
      lt(projectSoundtrackGenerations.started_at, processingCutoff),
    ),
  )).limit(50);

  for (const row of rows) {
    if (row.raw_r2_key) {
      await soundtrackGenerationQueue.add(
        'resume-postprocessing',
        { soundtrackId: row.id },
        { jobId: `resume-${row.id}-${row.retry_count + 1}` },
      );
      await db.update(projectSoundtrackGenerations)
        .set({ retry_count: row.retry_count + 1, started_at: now })
        .where(eq(projectSoundtrackGenerations.id, row.id));
    } else {
      await refundSoundtrack(row.id, 'generation_abandoned', 'Music generation did not finish');
    }
  }
}

export const soundtrackReaperWorker = new Worker(
  QUEUE_NAME,
  async () => reapStaleSoundtracks(),
  { connection, concurrency: 1 },
);

export async function scheduleSoundtrackReaper(): Promise<void> {
  await soundtrackReaperQueue.upsertJobScheduler(
    'ai-soundtrack-reaper-every-five-minutes',
    { every: 5 * 60_000 },
    { name: 'reap', data: {} },
  );
}
