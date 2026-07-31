-- Phase 20.2 (Video Background Removal) foundation migration.
-- Additive + re-runnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).
--
-- ⚠️ Migrations here are MANUAL: creating this file does NOT apply it. A human must run it
-- against the database Railway actually serves and then trigger a deploy.
--
-- ⚠️ DO NOT apply this through the local .env DATABASE_URL. As of 2026-07-28 .env points at the
-- Neon DEV branch (ep-rough-wildflower) while prod is a DIFFERENT branch (ep-noisy-bonus) with
-- DIFFERENT data. Read the real target with `railway variables` first — a migration "applied to
-- prod" via .env once broke prod for hours.
--
-- STATUS: APPLIED TO RAILWAY PRODUCTION AND VERIFIED (2026-07-30).

-- ─── video_background_removal_jobs ────────────────────────────────────────────
-- Job-tracking table for the atomic deduct/refund/status lifecycle, mirroring
-- audio_separation_jobs exactly (same statuses, same idempotency contract, same
-- refund shape).
--
-- Unlike audio separation — which ADDS stem rows and leaves the source in place —
-- background removal REPLACES the source clip's media: project_clips.r2_key is
-- swapped to the processed object. The replacement is timebase-preserving (same
-- duration, same frame timing), so every dependent piece of editor state
-- (trim_start/trim_end, splits, overlay time anchors, caption cues) stays valid
-- across the swap and needs no rewriting.
--
-- source_prior_r2_key records project_clips.r2_key AS IT WAS immediately BEFORE
-- the swap, so undo restores the exact original object. The prior object is never
-- hard-deleted by this feature (DECISIONS.md §3 recoverable model) — it stays in
-- R2 for the soft-delete/purge window like any other clip media.

DO $$ BEGIN
  CREATE TYPE video_bg_removal_status AS ENUM ('pending','processing','completed','failed','refunded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS video_background_removal_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  source_clip_id uuid NOT NULL REFERENCES project_clips(id),
  idempotency_key text NOT NULL,
  status video_bg_removal_status NOT NULL DEFAULT 'pending',
  provider text NOT NULL,
  model text NOT NULL,
  -- Requested background: 'Transparent' or one of Bria's solid-color enum values.
  background_color text NOT NULL DEFAULT 'Transparent',
  -- Container/codec actually SENT to the provider. Derived server-side from
  -- background_color (never client-chosen) — see videoBackgroundRemovalService.
  output_container_and_codec text NOT NULL,
  -- Billed duration, resolved server-side in explicit seconds (CLAUDE.md rule #7 —
  -- never a provider-side "intelligent"/auto duration).
  duration_seconds double precision NOT NULL,
  cost_credits integer NOT NULL,
  provider_request_id text,
  -- R2 key of the processed output. Provider URLs are NEVER stored here (rule #2).
  output_r2_key text,
  -- Undo state: the clip's r2_key before the swap.
  source_prior_r2_key text,
  failure_code text,
  failure_reason text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

-- Re-runnable guards, in case an earlier partial run created the table without these.
ALTER TABLE video_background_removal_jobs ADD COLUMN IF NOT EXISTS source_prior_r2_key text;
ALTER TABLE video_background_removal_jobs ADD COLUMN IF NOT EXISTS output_r2_key text;

-- Idempotency-Key contract: one job per (user, key). The service relies on the 23505
-- from this index to resolve concurrent duplicate submissions.
CREATE UNIQUE INDEX IF NOT EXISTS video_bg_removal_user_idempotency_unique_idx
  ON video_background_removal_jobs(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS video_bg_removal_status_created_idx
  ON video_background_removal_jobs(status, created_at);
-- Powers the "is there already a live/queued job for this clip?" guard.
CREATE INDEX IF NOT EXISTS video_bg_removal_source_clip_idx
  ON video_background_removal_jobs(source_clip_id);
