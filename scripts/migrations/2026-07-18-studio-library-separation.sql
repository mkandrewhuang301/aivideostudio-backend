-- Studio ↔ Library separation.
-- Safe to re-run: the column add is guarded and the backfill converges on the newest export.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_export_generation_id text;

WITH latest_export AS (
  SELECT DISTINCT ON (params ->> 'export_of_project_id')
    params ->> 'export_of_project_id' AS project_id,
    id::text AS generation_id
  FROM generations
  WHERE model = 'edit-studio-compose'
    AND params ->> 'export_of_project_id' IS NOT NULL
  ORDER BY
    params ->> 'export_of_project_id',
    created_at DESC,
    id DESC
)
UPDATE projects AS project
SET last_export_generation_id = latest_export.generation_id
FROM latest_export
WHERE project.id::text = latest_export.project_id
  AND project.last_export_generation_id IS DISTINCT FROM latest_export.generation_id;
