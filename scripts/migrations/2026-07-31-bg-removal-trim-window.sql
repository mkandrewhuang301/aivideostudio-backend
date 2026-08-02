-- Video Background Removal: bill and process the TRIMMED WINDOW, not the full source.
-- Additive + re-runnable (ADD COLUMN IF NOT EXISTS throughout).
--
-- ⚠️ Migrations here are MANUAL: creating this file does NOT apply it. A human must run it
-- against the database Railway actually serves and then trigger a deploy.
--
-- ⚠️ DO NOT apply this through the local .env DATABASE_URL — .env points at the Neon DEV branch
-- while prod is a DIFFERENT branch. Read the real target with `railway variables` first.
--
-- STATUS: NOT YET APPLIED (written 2026-07-31).
--
-- ─── Why ──────────────────────────────────────────────────────────────────────
-- The original design processed a clip's FULL source and billed for it. Two problems:
--
--   1. Overbilling: a 5-minute upload trimmed down to 5 visible seconds was billed for 5
--      minutes (126 credits) of provider work the user never sees.
--   2. Worse — outright rejection: videoBgRemovalMaxDurationSeconds (180s) was checked against
--      the FULL source, so that same 5-minute upload was refused with "clip is too long"
--      no matter how short the visible window was. The feature was unusable on long sources.
--
-- Processing only the visible window is safe here because clip rows never share media:
-- projectService.splitClip CopyObject's to an independent r2_key per row, so rewriting one
-- clip's media + trim bounds cannot affect any other row. Overlay/caption anchors live on the
-- PROJECT timeline and the clip's visible LENGTH is unchanged by the swap, so they stay put;
-- speed_curve positions are normalised 0..1 and are likewise unaffected.
--
-- The consequence is that the processed clip's own timebase is rebased to the trimmed window:
-- trim_start becomes 0 and trim_end/original_duration become the window length. These three
-- columns capture what those fields were BEFORE the rebase so undo restores the clip exactly,
-- alongside the existing source_prior_r2_key.

ALTER TABLE video_background_removal_jobs
  ADD COLUMN IF NOT EXISTS source_prior_trim_start_seconds double precision;
ALTER TABLE video_background_removal_jobs
  ADD COLUMN IF NOT EXISTS source_prior_trim_end_seconds double precision;
ALTER TABLE video_background_removal_jobs
  ADD COLUMN IF NOT EXISTS source_prior_original_duration_seconds double precision;
