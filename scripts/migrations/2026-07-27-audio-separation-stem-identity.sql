-- Phase 20.1 bugfix (WP1): stem identity + "one live pair per source clip" invariant.
-- Additive + re-runnable (ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS).
-- Reminder (schema-drift incident, 2026-07-25): migrations here are MANUAL to prod — creating
-- this file does NOT push it. A human must run this against prod + trigger the Railway deploy,
-- alongside the still-unrun 2026-07-26-audio-separation-stems.sql.

ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS separation_job_id uuid REFERENCES audio_separation_jobs(id);
ALTER TABLE project_audio_clips ADD COLUMN IF NOT EXISTS separation_role text;  -- 'residual' | 'target'

-- Backfill from the job table so already-created stems get identity (dev only; prod has none yet).
UPDATE project_audio_clips a SET separation_job_id = j.id, separation_role = 'residual'
  FROM audio_separation_jobs j WHERE j.residual_audio_clip_id = a.id AND a.separation_job_id IS NULL;
UPDATE project_audio_clips a SET separation_job_id = j.id, separation_role = 'target'
  FROM audio_separation_jobs j WHERE j.target_audio_clip_id = a.id AND a.separation_job_id IS NULL;

-- Retire every stem that is not from the NEWEST completed job for its source clip, so the
-- partial unique index below can be created on existing (dev) data. Soft-delete, never hard.
UPDATE project_audio_clips a
   SET deleted_at = now()
 WHERE a.source_type = 'separation' AND a.deleted_at IS NULL
   AND a.separation_job_id IS DISTINCT FROM (
     SELECT j.id FROM audio_separation_jobs j
      WHERE j.source_clip_id = a.source_clip_id AND j.status = 'completed'
      ORDER BY j.completed_at DESC NULLS LAST, j.created_at DESC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS project_audio_clips_live_stem_role_unique_idx
  ON project_audio_clips (source_clip_id, separation_role)
  WHERE source_type = 'separation' AND deleted_at IS NULL;
