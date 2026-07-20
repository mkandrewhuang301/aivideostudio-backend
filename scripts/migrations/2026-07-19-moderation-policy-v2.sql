-- Moderation policy v2 (2026-07-19)
-- Safe to run repeatedly against Neon before deploying the code that reads these columns.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS moderation_strikes integer NOT NULL DEFAULT 0;

ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS has_real_face_input boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ncmec_report_id text,
  ADD COLUMN IF NOT EXISTS ncmec_file_id text,
  ADD COLUMN IF NOT EXISTS ncmec_reported_at timestamptz;

CREATE INDEX IF NOT EXISTS generations_ncmec_report_id_idx
  ON generations (ncmec_report_id)
  WHERE ncmec_report_id IS NOT NULL;
