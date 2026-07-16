-- Migration: Archive Leave Type support (see docs/UPDATED_LEAVE_MODULE.md §14f)
-- Adds an explicit archive flag to LeavePolicy, as the proper alternative to
-- deletion for leave types with real history (which deletePolicy correctly
-- refuses to delete — see the LEAVE_POLICY_IN_USE guard).
--
-- Safe for a live table with existing rows:
--   - isArchived defaults to false -> every existing policy stays exactly as
--     visible/usable as it is today, no behavior change on deploy.
--   - archivedAt is nullable, no backfill needed.

ALTER TABLE "LeavePolicy"
  ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMPTZ(6);
