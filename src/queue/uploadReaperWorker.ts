// src/queue/uploadReaperWorker.ts
// BullMQ repeatable job (hourly) — deletes reference_uploads rows that were never given a
// display_name ("paperclip uploads") once they're older than 24 hours. Named references and
// uploads still referenced by a non-deleted generation are exempt: history Remix/Regen and the
// Magic Editor's source+mask overlay must remain reconstructible beyond the first day.
// Modeled after reaperWorker.ts's BullMQ pattern (Redis-persisted schedule survives restarts).

import { Queue, Worker } from 'bullmq';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { r2, R2_BUCKET } from '../storage/r2';

const QUEUE_NAME = 'upload-reaper';

const connectionOptions = {
  url: process.env.REDIS_URL ?? '',
  maxRetriesPerRequest: null as null,
  enableReadyCheck: false,
};

export const uploadReaperQueue = new Queue(QUEUE_NAME, { connection: connectionOptions });

interface ReapableUploadRow {
  id: string;
  r2_key: string;
}

export async function reapUnnamedUploads(): Promise<void> {
  const result = await db.execute(sql`
    SELECT id, r2_key
    FROM reference_uploads AS upload
    WHERE upload.display_name IS NULL
      AND upload.created_at < now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1
        FROM generations AS generation
        WHERE generation.status <> 'deleted'
          AND (
            COALESCE(generation.params->'ref_upload_ids', '[]'::jsonb) @> jsonb_build_array(upload.id::text)
            OR COALESCE(generation.params->'preset_input_upload_ids', '[]'::jsonb) @> jsonb_build_array(upload.id::text)
            OR generation.params->>'mask_upload_id' = upload.id::text
          )
      )
  `);

  for (const row of (result.rows ?? []) as unknown as ReapableUploadRow[]) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }));
      await db.execute(sql`DELETE FROM reference_uploads WHERE id = ${row.id}`);
      console.log(`[upload-reaper] Deleted unnamed upload ${row.id}`);
    } catch (err) {
      console.error(`[upload-reaper] Error deleting unnamed upload ${row.id}:`, err);
    }
  }
}

export async function scheduleUploadReaper(): Promise<void> {
  await uploadReaperQueue.add(
    'reap',
    {},
    { repeat: { every: 60 * 60 * 1000 }, jobId: 'upload-reaper-singleton' },
  );
}

export const uploadReaperWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await reapUnnamedUploads();
  },
  { connection: connectionOptions, concurrency: 1 },
);
