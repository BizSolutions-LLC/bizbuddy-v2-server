-- Migration: Phase 2 of Leave Module redo (see docs/UPDATED_LEAVE_MODULE.md)
-- Formalizes Leave.leaveType (which already stores a LeavePolicy id for every
-- request submitted through submitLeaveRequest) into a real, indexed FK column.
--
-- Safe for a live table with existing rows:
--   - policyId is nullable, no NOT NULL constraint added.
--   - leaveType is untouched and kept as-is (legacy/display fallback field) —
--     nothing currently reading leaveType breaks.
--   - Backfill runs in two passes mirroring _resolvePolicy()'s existing
--     ID-first-then-name-fallback logic, so it's safe to run even if some
--     historical rows still have a plain leaveType name instead of an id.

ALTER TABLE "Leave"
  ADD COLUMN "policyId" TEXT;

ALTER TABLE "Leave"
  ADD CONSTRAINT "Leave_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "LeavePolicy"("id");

CREATE INDEX "Leave_policyId_idx" ON "Leave"("policyId");

-- Pass 1: leaveType already holds a valid LeavePolicy id (the common case today)
UPDATE "Leave" l
SET "policyId" = l."leaveType"
WHERE l."policyId" IS NULL
  AND EXISTS (SELECT 1 FROM "LeavePolicy" lp WHERE lp."id" = l."leaveType");

-- Pass 2: leaveType is a plain type name (older/legacy rows) — resolve by
-- name within the requester's own company, same as _resolvePolicy()'s fallback.
UPDATE "Leave" l
SET "policyId" = lp."id"
FROM "LeavePolicy" lp, "User" u
WHERE l."policyId" IS NULL
  AND u."id" = l."userId"
  AND lp."companyId" = u."companyId"
  AND lp."leaveType" = l."leaveType";

-- Any rows still NULL after both passes had no resolvable policy (e.g. the
-- policy was since deleted) — left NULL intentionally, leaveType remains as
-- the only record of what was originally requested.
