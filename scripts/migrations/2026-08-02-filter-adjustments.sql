-- Adjust tab (brightness/contrast/saturation/etc.) — additive + re-runnable migration.
--
-- ⚠️ Migrations here are MANUAL: creating this file does NOT apply it. A human must run it
-- against the database Railway actually serves and then trigger a deploy.
--
-- ⚠️ DO NOT apply this through the local .env DATABASE_URL. As of 2026-07-28 .env points at the
-- Neon DEV branch (ep-rough-wildflower) while prod is a DIFFERENT branch (ep-noisy-bonus) with
-- DIFFERENT data. Read the real target with `railway variables` first — a migration "applied to
-- prod" via .env once broke prod for hours.
--
-- STATUS: NOT YET APPLIED.

-- ─── project_filters — adjustments ────────────────────────────────────────────
-- See ~/.planning/notes/2026-08-02-adjust-tab-plan.md. An "adjustment" reuses project_filters
-- rather than a parallel table/timeline object: it is the SAME row shape, just carrying compiled
-- LUT parameters instead of (or alongside) a catalog filter_id.
--
-- Row semantics after this migration:
--   filter_id set,  adjustments null  -> today's bundled look (unchanged).
--   filter_id null, adjustments set   -> an adjustment stack (brightness/contrast/...).
--   both set                         -> a bundled look with tweaks on top.
--
-- filter_id therefore drops its NOT NULL — an adjustment-only row has no catalog id to store.
-- adjustments is a plain jsonb blob of Adjustments (src/config/adjustmentLut.ts); it is compiled
-- to a 17^3 .cube at render time (both in the compose worker and on iOS) rather than interpreted
-- as image operations, which is what keeps the live preview and the export in agreement — see the
-- doc comment at the top of adjustmentLut.ts for the full rationale.

ALTER TABLE project_filters ALTER COLUMN filter_id DROP NOT NULL;
ALTER TABLE project_filters ADD COLUMN IF NOT EXISTS adjustments jsonb;
