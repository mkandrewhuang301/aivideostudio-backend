-- Repair: fal SAM Audio target/residual buffers were archived under the wrong R2 keys
-- (provider field contents were inverted vs documented names). After FalSamAudioProvider
-- started crossing the fields on ingest, existing live stem pairs still have swapped audio.
--
-- Swaps r2_key between each live residual/target pair that shares a separation_job_id, and
-- mirrors the swap onto audio_separation_jobs.target_r2_key / residual_r2_key.
-- Additive / re-runnable: a second run swaps back, so only run once after deploying the
-- provider fix. Soft-deleted stems are left alone.

WITH pairs AS (
  SELECT
    r.id AS residual_id,
    r.r2_key AS residual_key,
    t.id AS target_id,
    t.r2_key AS target_key,
    r.separation_job_id AS job_id
  FROM project_audio_clips r
  JOIN project_audio_clips t
    ON t.separation_job_id = r.separation_job_id
   AND t.separation_role = 'target'
   AND t.deleted_at IS NULL
   AND t.source_type = 'separation'
  WHERE r.separation_role = 'residual'
    AND r.deleted_at IS NULL
    AND r.source_type = 'separation'
    AND r.separation_job_id IS NOT NULL
)
UPDATE project_audio_clips a
SET r2_key = CASE
  WHEN a.id = p.residual_id THEN p.target_key
  WHEN a.id = p.target_id THEN p.residual_key
  ELSE a.r2_key
END
FROM pairs p
WHERE a.id IN (p.residual_id, p.target_id);

WITH pairs AS (
  SELECT
    r.separation_job_id AS job_id,
    r.r2_key AS residual_key,
    t.r2_key AS target_key
  FROM project_audio_clips r
  JOIN project_audio_clips t
    ON t.separation_job_id = r.separation_job_id
   AND t.separation_role = 'target'
   AND t.deleted_at IS NULL
   AND t.source_type = 'separation'
  WHERE r.separation_role = 'residual'
    AND r.deleted_at IS NULL
    AND r.source_type = 'separation'
    AND r.separation_job_id IS NOT NULL
)
UPDATE audio_separation_jobs j
SET
  target_r2_key = p.target_key,
  residual_r2_key = p.residual_key
FROM pairs p
WHERE j.id = p.job_id
  AND j.target_r2_key IS DISTINCT FROM p.target_key;
