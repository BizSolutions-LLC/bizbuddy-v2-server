-- Migration: add LeaveTransaction ledger table

CREATE TYPE "LeaveTransactionType" AS ENUM ('accrual', 'deduction', 'adjustment');

CREATE TABLE "LeaveTransaction" (
  "id"            TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  "policyId"      TEXT        NOT NULL,
  "type"          "LeaveTransactionType" NOT NULL,
  "hours"         DECIMAL(8,2) NOT NULL,
  "balanceBefore" DECIMAL(8,2) NOT NULL,
  "balanceAfter"  DECIMAL(8,2) NOT NULL,
  "leaveId"       TEXT,
  "performedById" TEXT,
  "note"          TEXT,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "LeaveTransaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LeaveTransaction"
  ADD CONSTRAINT "LeaveTransaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "LeaveTransaction_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "LeavePolicy"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "LeaveTransaction_performedById_fkey"
    FOREIGN KEY ("performedById") REFERENCES "User"("id");

CREATE INDEX "LeaveTransaction_userId_policyId_idx" ON "LeaveTransaction"("userId", "policyId");
CREATE INDEX "LeaveTransaction_leaveId_idx"          ON "LeaveTransaction"("leaveId");
