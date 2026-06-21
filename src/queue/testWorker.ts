// src/queue/testWorker.ts
// Run directly: npx tsx src/queue/testWorker.ts
// Exits 0 if BullMQ enqueue+process works, exits 1 on failure.

import 'dotenv/config';
import { Queue, Worker } from 'bullmq';

const QUEUE_NAME = 'smoke-test';

// BullMQ bundles its own ioredis; pass the URL string so it uses its own copy.
// maxRetriesPerRequest: null is required by BullMQ.
const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

async function main() {
  const queue = new Queue(QUEUE_NAME, { connection: connectionOptions });

  let resolved = false;

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[BullMQ] Processing job ${job.id}: ${JSON.stringify(job.data)}`);
      return { processed: true, at: new Date().toISOString() };
    },
    { connection: connectionOptions, concurrency: 1 },
  );

  const result = await new Promise<boolean>((resolve) => {
    worker.on('completed', (job, returnValue) => {
      console.log(`[BullMQ] Job ${job?.id} completed:`, returnValue);
      resolved = true;
      resolve(true);
    });

    worker.on('failed', (job, err) => {
      console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
      resolve(false);
    });

    // Enqueue after worker is listening
    setTimeout(async () => {
      const job = await queue.add('test-job', { message: 'smoke-test', ts: Date.now() });
      console.log(`[BullMQ] Enqueued job ${job.id}`);
    }, 500);

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!resolved) {
        console.error('[BullMQ] Timeout: job not processed within 10s');
        resolve(false);
      }
    }, 10_000);
  });

  await worker.close();
  await queue.close();

  if (!result) {
    process.exit(1);
  }
  console.log('[BullMQ] Smoke test PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('[BullMQ] Fatal error:', err);
  process.exit(1);
});
