-- Phase 20.1 chaining: a separation source may be a project_clips row OR another
-- project_audio_clips row (a track), to arbitrary depth. Either output track is separable again.
--
-- The live shape is FLAT, not a tree. Separating a TRACK consumes it: the source row is
-- soft-deleted and replaced by the two tracks it decomposes into, so a parent and its children
-- never coexist and nothing can double-count in the mix (the mix is the sum of enabled rows).
-- Separating a CLIP is the exception — a clip still has picture, so it can't be consumed; that
-- path mutes the clip's own audio and adds two tracks, exactly as before.
--
-- parent_audio_clip_id and separation_depth are therefore PROVENANCE (undo, debugging, and the
-- retry guard below), not structure any client has to render.
--
-- Additive + re-runnable (ADD COLUMN IF NOT EXISTS / DO-block guards). Existing stems backfill as
-- depth 1 with a NULL parent, so nothing already created changes meaning.
--
-- NOTE: source_clip_id stays populated on EVERY stem (the clip it ultimately came from) — used by
-- the R2/delete sweeps. The live-pair uniqueness index keys on the IMMEDIATE parent,
-- COALESCE(parent_audio_clip_id, source_clip_id), so a depth-2 pair can't collide with the
-- depth-1 pair that shares its root clip.

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
