-- Migration: extend LeaveTransaction into a unified Leave Ledger.
--
-- Reuses the existing balance-movement ledger table to also carry the
-- non-monetary lifecycle events (submitted/escalated/approved/rejected/cancelled),
-- so a single chronological query gives the full "Leave Ledger" timeline
-- (balance movements + status transitions) without merging two tables
-- client-side. See docs/UPDATED_LEAVE_MODULE.md for the fuller writeup.
--
-- Safe for a live table with existing rows:
--   - New enum values are purely additive — existing accrual/deduction/
--     adjustment rows and every consumer that filters on those types
--     (e.g. the Used-hours derivation in listBalances/listMatrix, which
--     explicitly filters type = 'deduction') are unaffected.
--   - hours/balanceBefore/balanceAfter are loosened to nullable, not
--     tightened — existing rows already have values, no backfill needed.
--     The five new event types simply have no balance to report, so they
--     write null instead of a fabricated 0/duplicate-balance value.

ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'escalated';
ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "LeaveTransactionType" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "LeaveTransaction"
  ALTER COLUMN "hours" DROP NOT NULL,
  ALTER COLUMN "balanceBefore" DROP NOT NULL,
  ALTER COLUMN "balanceAfter" DROP NOT NULL;
