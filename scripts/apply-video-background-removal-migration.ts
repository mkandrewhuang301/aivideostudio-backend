import { neon } from '@neondatabase/serverless';

const PROD_ENDPOINT = 'ep-noisy-bonus-attd9tbz';
const shouldApply = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set');
}

if (!databaseUrl.includes(PROD_ENDPOINT)) {
  throw new Error(`Refusing to target an unexpected database (expected ${PROD_ENDPOINT})`);
}

if (shouldApply && process.env.ALLOW_PROD_DB !== '1') {
  throw new Error('Set ALLOW_PROD_DB=1 to apply this migration to production');
}

const sql = neon(databaseUrl);

async function tableExists(): Promise<boolean> {
  const rows = await sql`
    SELECT to_regclass('public.video_background_removal_jobs') IS NOT NULL AS exists
  `;
  return rows[0]?.exists === true;
}

async function main() {
  const existedBefore = await tableExists();
  console.log(`video_background_removal_jobs exists before: ${existedBefore}`);

  if (!shouldApply) {
    return;
  }

  await sql`
    DO $$ BEGIN
      CREATE TYPE video_bg_removal_status AS ENUM (
        'pending',
        'processing',
        'completed',
        'failed',
        'refunded'
      );
    EXCEPTION WHEN duplicate_object THEN null;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS video_background_removal_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      project_id uuid NOT NULL REFERENCES projects(id),
      source_clip_id uuid NOT NULL REFERENCES project_clips(id),
      idempotency_key text NOT NULL,
      status video_bg_removal_status NOT NULL DEFAULT 'pending',
      provider text NOT NULL,
      model text NOT NULL,
      background_color text NOT NULL DEFAULT 'Transparent',
      output_container_and_codec text NOT NULL,
      duration_seconds double precision NOT NULL,
      cost_credits integer NOT NULL,
      provider_request_id text,
      output_r2_key text,
      source_prior_r2_key text,
      failure_code text,
      failure_reason text,
      retry_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz
    )
  `;

  await sql`
    ALTER TABLE video_background_removal_jobs
      ADD COLUMN IF NOT EXISTS source_prior_r2_key text
  `;
  await sql`
    ALTER TABLE video_background_removal_jobs
      ADD COLUMN IF NOT EXISTS output_r2_key text
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS video_bg_removal_user_idempotency_unique_idx
      ON video_background_removal_jobs(user_id, idempotency_key)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS video_bg_removal_status_created_idx
      ON video_background_removal_jobs(status, created_at)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS video_bg_removal_source_clip_idx
      ON video_background_removal_jobs(source_clip_id)
  `;

  const existedAfter = await tableExists();
  if (!existedAfter) {
    throw new Error('Migration completed without creating video_background_removal_jobs');
  }

  console.log('video_background_removal_jobs migration applied and verified');
}

main().catch((error) => {
  console.error('video background removal migration failed:', error);
  process.exit(1);
});
