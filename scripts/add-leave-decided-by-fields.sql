-- Migration: audit-trail fields for who actually acted on a leave request.
--
-- Since Phase 4 broadened approval eligibility (any admin, or any supervisor
-- in the requester's department — not just the named approverId/
-- secondaryApproverId, see docs/UPDATED_LEAVE_MODULE.md §8), those two
-- fields no longer reliably answer "who decided this." They record who the
-- request was assigned/escalated to, not who actually acted.
--
-- Two fields cover the full decision chain:
--   - escalatedByUserId — first-stage reviewer who chose to escalate rather
--     than decide directly. Null if the leave was ever decided in one step.
--   - decidedByUserId   — whoever made the final approve/reject call,
--     whether that happened directly from "pending" or after escalation
--     from "pending_secondary".
--
-- Safe for a live table with existing rows:
--   - Both columns are nullable, no backfill — existing decided leaves
--     simply have these as null (the actual actor isn't recoverable after
--     the fact).
--   - FK + index added to match the original approverId convention
--     (baseline_migration.sql) and the Phase 2 policyId migration
--     (scripts/add-leave-policyid-fk.sql), rather than the looser
--     no-FK precedent set by secondaryApproverId.

ALTER TABLE "Leave"
  ADD COLUMN "escalatedByUserId" TEXT,
  ADD COLUMN "decidedByUserId" TEXT;

ALTER TABLE "Leave"
  ADD CONSTRAINT "Leave_escalatedByUserId_fkey"
    FOREIGN KEY ("escalatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Leave"
  ADD CONSTRAINT "Leave_decidedByUserId_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Leave_escalatedByUserId_idx" ON "Leave"("escalatedByUserId");
CREATE INDEX "Leave_decidedByUserId_idx" ON "Leave"("decidedByUserId");
