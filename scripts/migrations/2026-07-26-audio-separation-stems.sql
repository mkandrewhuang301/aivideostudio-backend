-- Phase 20.1 (Audio Separation) foundation migration.
-- Additive + re-runnable (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS throughout).
-- Migrations here are MANUAL: creating this file does NOT apply it. A human must run it and
-- trigger the Railway deploy.
--
-- STATUS 2026-07-27: APPLIED. Verified live via information_schema — every column and the
-- audio_separation_jobs table are present in the database Railway actually serves.
--
-- CORRECTION 2026-07-27: this file previously claimed it was applied to "dev" but still owed
-- against prod. That was never true. The DATABASE_URL in the local .env and the one Railway
-- injects into the aivideostudio-backend service were byte-identical (same Neon endpoint,
-- same neondb) — so "applying to dev" applied to prod in the same statement. Any earlier note
-- distinguishing the two environments is describing a separation that did not exist.

-- ─── PART A: extend project_audio_clips with DAW mix fields + stem link ───────
-- Stems (separation's "target"/"residual" output) are stored as ordinary
-- project_audio_clips rows (source_type = 'separation'), NOT a new parallel table
-- (the sketch's standalone-table design in DECISIONS.md §3 is SUPERSEDED).

ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS gain double precision NOT NULL DEFAULT 1;
ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS prompt text;
ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS source_clip_id uuid REFERENCES project_clips(id);

ALTER TABLE project_audio_clips DROP CONSTRAINT IF EXISTS project_audio_clips_gain_range;
ALTER TABLE project_audio_clips ADD CONSTRAINT project_audio_clips_gain_range CHECK (gain >= 0 AND gain <= 2);

-- ─── PART B: audio_separation_jobs — job-tracking table for the atomic ────────
-- deduct/refund/status lifecycle (mirrors project_soundtrack_generations).
--
-- source_prior_volume (nullable double precision) records the source clip's
-- project_clips.volume value AS IT WAS immediately BEFORE separation muted it to 0,
-- so undo (Plan 06) can restore the user's exact prior volume — e.g. a clip already
-- at 0.7 restores to 0.7, not a hardcoded 1.0. The source-mute path is volume-based
-- because project_clips has no `enabled` column, hence a single float capture column
-- (no source_prior_enabled needed).

DO $$ BEGIN
  CREATE TYPE audio_separation_status AS ENUM ('pending','processing','completed','failed','refunded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS audio_separation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  source_clip_id uuid NOT NULL REFERENCES project_clips(id),
  idempotency_key text NOT NULL,
  status audio_separation_status NOT NULL DEFAULT 'pending',
  provider text NOT NULL,
  model text NOT NULL,
  prompt text NOT NULL,
  duration_seconds double precision NOT NULL,
  cost_credits integer NOT NULL,
  provider_request_id text,
  target_r2_key text,
  residual_r2_key text,
  target_audio_clip_id uuid,
  residual_audio_clip_id uuid,
  source_prior_volume double precision,
  failure_code text,
  failure_reason text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

-- Re-runnable guard: if audio_separation_jobs already existed from a prior run without this column.
ALTER TABLE audio_separation_jobs ADD COLUMN IF NOT EXISTS source_prior_volume double precision;

CREATE UNIQUE INDEX IF NOT EXISTS audio_sep_user_idempotency_unique_idx ON audio_separation_jobs(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS audio_sep_status_created_idx ON audio_separation_jobs(status, created_at);
