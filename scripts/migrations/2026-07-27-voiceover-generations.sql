-- Phase 20 (Editor Audio Workspace) voiceover migration.
-- Additive + re-runnable (IF NOT EXISTS / DO-block enum guard throughout).
-- Provenance: this DDL was dumped from the DEV database, where these objects were created
-- by Plan 20-05 (see .continue-here.md — drizzle-kit push is BANNED; this file is the
-- canonical, manually-applied path to prod). Verified against dev 2026-07-27: enum labels,
-- column set/nullability/defaults, FK targets, and index definitions all match.
-- Reminder (schema-drift incident, 2026-07-25): migrations here are MANUAL to prod — creating
-- this file does NOT push it. A human must run this against prod + trigger the Railway deploy.

-- ─── PART A: voiceover_generation_status enum ───────────────────────────────

DO $$ BEGIN
  CREATE TYPE voiceover_generation_status AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── PART B: project_voiceover_generations ──────────────────────────────────
-- Standalone AI Voiceover generations, persisted independently from timeline audio
-- clips so a generated narration can be previewed before insertion into a project.

CREATE TABLE IF NOT EXISTS project_voiceover_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  idempotency_key text NOT NULL,
  status voiceover_generation_status NOT NULL DEFAULT 'pending',
  -- Client-submitted voice id; provider/model resolved server-side.
  voice_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  speaker text,
  -- Full script stored for retry/audit; bounded 1..5000 characters.
  script text NOT NULL,
  -- Server-authoritative pricing snapshot so later quote changes don't retroactively bill.
  pricing_version text NOT NULL,
  estimated_provider_cents double precision NOT NULL,
  cost_credits integer NOT NULL,
  -- Provider checkpoint fields.
  provider_request_id text,
  raw_r2_key text,
  -- Final deliverable.
  final_r2_key text,
  mime_type text,
  duration_seconds double precision,
  -- Failure/refund audit.
  failure_code text,
  failure_reason text,
  retry_count integer NOT NULL DEFAULT 0,
  -- Link to the timeline audio clip once inserted into a project.
  attached_audio_clip_id uuid REFERENCES project_audio_clips(id),
  -- Short-lived processing lease so a single worker owns the row.
  processing_token text,
  processing_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS voiceovers_user_idempotency_unique_idx
  ON project_voiceover_generations (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS voiceovers_project_created_idx
  ON project_voiceover_generations (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voiceovers_status_created_idx
  ON project_voiceover_generations (status, created_at);
CREATE INDEX IF NOT EXISTS voiceovers_user_created_idx
  ON project_voiceover_generations (user_id, created_at DESC);
