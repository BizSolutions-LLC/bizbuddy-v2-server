-- Migration: Phase 1 of Leave Module redo (see docs/UPDATED_LEAVE_MODULE.md)
-- Adds pay-mode permission flags + explicit assignment model to LeavePolicy ("Leave Type").
--
-- Safe for a live table with existing rows:
--   - isPaid / isNotPaid default to true  -> every existing policy keeps allowing both
--     paid and unpaid requests, matching today's behavior (no admin action required).
--   - assignedToAll defaults to true      -> every existing policy stays available to
--     everyone, matching today's implicit "any employee can use any leave type"
--     behavior. LeavePolicyAssignment rows only matter once an admin explicitly
--     narrows a policy to assignedToAll = false.
-- No backfill of LeavePolicyAssignment is required for existing data as a result.

ALTER TABLE "LeavePolicy"
  ADD COLUMN "isPaid"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isNotPaid"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "assignedToAll" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "LeavePolicyAssignment" (
  "id"        TEXT           NOT NULL,
  "policyId"  TEXT           NOT NULL,
  "userId"    TEXT           NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "LeavePolicyAssignment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LeavePolicyAssignment"
  ADD CONSTRAINT "LeavePolicyAssignment_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "LeavePolicy"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "LeavePolicyAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "LeavePolicyAssignment_policyId_userId_key" ON "LeavePolicyAssignment"("policyId", "userId");
CREATE INDEX "LeavePolicyAssignment_userId_idx" ON "LeavePolicyAssignment"("userId");
