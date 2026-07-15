-- Migration: Phase 4 of Leave Module redo (see docs/UPDATED_LEAVE_MODULE.md)
-- Adds the per-day paid/unpaid breakdown table used by the new proration-on-
-- approval logic.
--
-- Safe for a live table with existing rows:
--   - Purely additive — a brand new table, no columns added to any existing
--     table, nothing to backfill for this to work going forward.
--   - Historical approved leaves (approved before this ships) simply have no
--     LeaveDay rows — they keep working exactly as before (they already went
--     through the old single-transaction deduction). This does NOT retroactively
--     reconstruct their day-level breakdown.
--   - An optional, separate backfill for historical leaves is available in
--     scripts/backfill-leave-days-legacy.js (Node script, not SQL — it reuses
--     the app's own calcDailyHours() so historical day splits are accurate to
--     actual scheduled hours/holidays, not guessed at in SQL). Run it manually
--     if/when you want historical LeaveDay rows for reporting; it's not required
--     for the new approval flow to work correctly on new requests.

CREATE TABLE "LeaveDay" (
  "id"        TEXT           NOT NULL,
  "leaveId"   TEXT           NOT NULL,
  "date"      DATE           NOT NULL,
  "isPaid"    BOOLEAN        NOT NULL,
  "hours"     DECIMAL(6,2)   NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "LeaveDay_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LeaveDay"
  ADD CONSTRAINT "LeaveDay_leaveId_fkey"
    FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "LeaveDay_leaveId_date_key" ON "LeaveDay"("leaveId", "date");
CREATE INDEX "LeaveDay_leaveId_idx" ON "LeaveDay"("leaveId");
