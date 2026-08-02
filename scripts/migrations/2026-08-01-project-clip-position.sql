ALTER TABLE project_clips
  ADD COLUMN IF NOT EXISTS x_norm double precision NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS y_norm double precision NOT NULL DEFAULT 0.5;

ALTER TABLE project_clips
  DROP CONSTRAINT IF EXISTS project_clips_x_norm_range,
  DROP CONSTRAINT IF EXISTS project_clips_y_norm_range;

ALTER TABLE project_clips
  ADD CONSTRAINT project_clips_x_norm_range CHECK (x_norm >= 0 AND x_norm <= 1),
  ADD CONSTRAINT project_clips_y_norm_range CHECK (y_norm >= 0 AND y_norm <= 1);
