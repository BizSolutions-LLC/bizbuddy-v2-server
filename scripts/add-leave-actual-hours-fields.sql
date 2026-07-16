-- Migration: persist the real per-day proration outcome onto Leave.
--
-- Bug: Leave.isPaid reflects only the employee's submitted intent and is
-- never updated after approval. The real outcome (computed in
-- applyLeaveApproval, leaveApprovalService.js) only ever lived on the
-- LeaveDay child rows — the parent Leave record, and anything reading it
-- (e.g. the client's Pay Type badge), never saw it. A fully-unpaid outcome
-- (0h balance at approval) still shows as "Paid Leave" at the top level even
-- though the day breakdown correctly shows unpaid — confirmed via a real
-- Maternity Leave case. This also contradicts docs/CLIENT_LEAVE_CONTRACT.md's
-- claim that "Approved leave response now reflects the real outcome" — that
-- was never actually implemented for the top-level fields.
--
-- Safe for a live table with existing rows:
--   - Both columns are nullable, no NOT NULL constraint.
--   - Unlike escalatedByUserId/decidedByUserId (genuinely unrecoverable for
--     already-decided leaves), these ARE recoverable: LeaveDay already
--     stores the true per-day paid/unpaid split for every leave that went
--     through Phase 4 (or its historical backfill,
--     scripts/backfill-leave-days-legacy.js). The backfill below derives
--     actualPaidHours/actualUnpaidHours from those existing rows, fixing
--     the already-reported case immediately rather than only preventing
--     recurrence going forward.
--   - Leaves with no LeaveDay rows (rejected, or approved before any Phase 4
--     backfill ran) are left null — correctly, there's nothing to derive.

ALTER TABLE "Leave"
  ADD COLUMN "actualPaidHours" DECIMAL(6, 2),
  ADD COLUMN "actualUnpaidHours" DECIMAL(6, 2);

-- Backfill from existing LeaveDay rows (real per-day outcome, already correct)
UPDATE "Leave" l
SET
  "actualPaidHours"   = agg.paid,
  "actualUnpaidHours" = agg.unpaid
FROM (
  SELECT
    "leaveId",
    COALESCE(SUM(hours) FILTER (WHERE "isPaid" = true),  0) AS paid,
    COALESCE(SUM(hours) FILTER (WHERE "isPaid" = false), 0) AS unpaid
  FROM "LeaveDay"
  GROUP BY "leaveId"
) agg
WHERE l.id = agg."leaveId";
