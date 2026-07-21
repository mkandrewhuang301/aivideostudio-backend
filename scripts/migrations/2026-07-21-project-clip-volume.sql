-- Per-clip source audio level for Edit Studio. Existing clips remain at their original level.
ALTER TABLE project_clips
ADD COLUMN IF NOT EXISTS volume double precision NOT NULL DEFAULT 1;

ALTER TABLE project_clips
DROP CONSTRAINT IF EXISTS project_clips_volume_range;

ALTER TABLE project_clips
ADD CONSTRAINT project_clips_volume_range CHECK (volume >= 0 AND volume <= 1);
