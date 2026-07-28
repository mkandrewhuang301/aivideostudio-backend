-- Repair existing live separation stems that were attached at start_offset_seconds=0
-- regardless of which source clip they came from. Places each stem at the project-timeline
-- start of its source clip (sum of earlier clips' visible durations).
--
-- Also included: optional r2_key swap for inverted fal target/residual (see
-- 2026-07-27-swap-inverted-separation-stem-audio.sql). Run THAT file once after deploying the
-- FalSamAudioProvider field-cross fix if stems still sound label-swapped; this file only
-- fixes placement.
--
-- Re-runnable: recomputes offsets from current clip order every time.

WITH ordered AS (
  SELECT
    id,
    project_id,
    sort_order,
    GREATEST(
      0,
      COALESCE(trim_end_seconds, original_duration_seconds, 0) - COALESCE(trim_start_seconds, 0)
    ) AS dur
  FROM project_clips
  WHERE deleted_at IS NULL
),
offsets AS (
  SELECT
    id,
    COALESCE(
      SUM(dur) OVER (
        PARTITION BY project_id
        ORDER BY sort_order, id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS timeline_offset
  FROM ordered
)
UPDATE project_audio_clips a
SET start_offset_seconds = o.timeline_offset
FROM offsets o
WHERE a.source_clip_id = o.id
  AND a.source_type = 'separation'
  AND a.deleted_at IS NULL
  AND a.start_offset_seconds IS DISTINCT FROM o.timeline_offset;
