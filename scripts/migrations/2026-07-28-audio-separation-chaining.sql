-- Phase 20.1 chaining: a separation source may be a project_clips row (root, depth 1) OR another
-- project_audio_clips row (a stem), to arbitrary depth. Either stem of a pair is separable, so the
-- shape is a tree: each audio row can own at most one live residual/target pair beneath it.
--
-- Additive + re-runnable (ADD COLUMN IF NOT EXISTS / DO-block guards). Existing stems backfill as
-- depth 1 with a NULL parent, so nothing already created changes meaning.
--
-- NOTE on provenance: source_clip_id stays populated on EVERY stem (the root clip it ultimately
-- came from) — useful for grouping and for the R2/delete sweeps. The immediate parent is
-- parent_audio_clip_id, which is NULL only at depth 1. The live-pair uniqueness index therefore
-- keys on the IMMEDIATE parent, COALESCE(parent_audio_clip_id, source_clip_id), or depth-2 stems
-- would collide with their depth-1 siblings on (source_clip_id, separation_role).

-- ─── project_audio_clips: tree edges ─────────────────────────────────────────

ALTER TABLE project_audio_clips
  ADD COLUMN IF NOT EXISTS parent_audio_clip_id uuid REFERENCES project_audio_clips(id),
  ADD COLUMN IF NOT EXISTS separation_depth integer NOT NULL DEFAULT 0;

-- Every pre-existing stem was separated directly from a clip.
UPDATE project_audio_clips
   SET separation_depth = 1
 WHERE source_type = 'separation'
   AND parent_audio_clip_id IS NULL
   AND separation_depth = 0;

CREATE INDEX IF NOT EXISTS project_audio_clips_parent_idx
  ON project_audio_clips (parent_audio_clip_id)
  WHERE parent_audio_clip_id IS NOT NULL;

-- Replace the clip-keyed live-pair guard with a parent-keyed one. Same invariant ("at most one
-- live residual/target pair per source"), now expressed against the immediate parent so it holds
-- at every depth.
DROP INDEX IF EXISTS project_audio_clips_live_stem_role_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS project_audio_clips_live_stem_parent_role_unique_idx
  ON project_audio_clips (COALESCE(parent_audio_clip_id, source_clip_id), separation_role)
  WHERE source_type = 'separation' AND deleted_at IS NULL;

-- ─── audio_separation_jobs: polymorphic source ───────────────────────────────

ALTER TABLE audio_separation_jobs
  ADD COLUMN IF NOT EXISTS source_audio_clip_id uuid REFERENCES project_audio_clips(id),
  -- Undo state for an audio-sourced job, mirroring source_prior_volume for a clip-sourced one:
  -- separating a stem switches it OFF, and undo must restore the exact prior enabled/gain.
  ADD COLUMN IF NOT EXISTS source_prior_enabled boolean,
  ADD COLUMN IF NOT EXISTS source_prior_gain double precision;

-- A job sourced from a stem has no clip of its own.
ALTER TABLE audio_separation_jobs ALTER COLUMN source_clip_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audio_sep_jobs_one_source_chk'
  ) THEN
    ALTER TABLE audio_separation_jobs
      ADD CONSTRAINT audio_sep_jobs_one_source_chk
      CHECK ((source_clip_id IS NOT NULL) <> (source_audio_clip_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audio_sep_jobs_source_audio_clip_idx
  ON audio_separation_jobs (source_audio_clip_id)
  WHERE source_audio_clip_id IS NOT NULL;
