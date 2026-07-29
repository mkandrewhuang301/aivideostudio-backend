-- Sketch 016 (2026-07-29, caption-text-style-sheets-plan.md): per-overlay style for Text
-- overlays — {font, color, background, backgroundColor, bold, outline, shadow, allCaps,
-- opacity, fontSize}, camelCase jsonb round-tripped verbatim (same convention as projects'
-- caption_style). NULL = the legacy fixed-white-Inter look in both the editor preview and
-- the ASS export, so existing rows need no backfill.
ALTER TABLE project_text_overlays
  ADD COLUMN IF NOT EXISTS style jsonb;
