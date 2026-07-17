-- Migration: add requestedStartTime/requestedEndTime to Leave (BB-048).
--
-- Employee-entered daily time window from the "New leave request" form.
-- Used only as the no-shift-day fallback in calcDailyHours (leaveUtils.js):
-- a day within the leave range that has no plotted UserShift now computes
-- its hours from this time window (capped at Company.defaultShiftHours)
-- instead of silently contributing 0h. Days with an actual plotted shift
-- are completely unaffected — this only fills the gap that previously
-- had no fallback at all.
--
-- Additive, nullable — safe for a live table. Existing leaves simply have
-- both columns null, which calcDailyHours treats the same as before this
-- change (flat defaultShiftHours fallback, no time-of-day math). No backfill.

ALTER TABLE "Leave" ADD COLUMN IF NOT EXISTS "requestedStartTime" TIME(6);
ALTER TABLE "Leave" ADD COLUMN IF NOT EXISTS "requestedEndTime" TIME(6);
