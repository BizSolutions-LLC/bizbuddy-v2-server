-- Payroll integration prep — archive tables for securing the reviewed/approved
-- punch and leave data before it feeds an external payroll system, plus a
-- results table for the computed per-employee export.
--
-- Purely additive: 4 brand-new tables, no existing table is touched. Safe to
-- run any time. Run once, then run scripts/archive-and-export-payroll-2026-07-08-to-21.js
-- to populate them.
--
--   CutoffPunchArchive — one row per approved TimeLogApproval, denormalized
--     (employee name/employeeId copied at snapshot time, since User fields
--     are mutable and this is meant to be an independent, frozen copy).
--   LeaveDayArchive     — one row per LeaveDay overlapping the archived period.
--   PayrollExport       — one row per employee: the computed Regular/OT/Driver/
--     Training/PTO totals actually handed to the payroll integration.
--   PayrollExportBatch  — one row per company+period generation run, holding
--     the exact same JSON array (as JSONB) that gets written to the handoff
--     file — so a future "fetch" (script or endpoint) can just SELECT the
--     payload column and return it as-is, no reconstruction from PayrollExport's
--     columns needed.

CREATE TABLE IF NOT EXISTS "CutoffPunchArchive" (
  id                  BIGSERIAL PRIMARY KEY,
  "periodStart"       DATE NOT NULL,
  "periodEnd"         DATE NOT NULL,
  "companyId"         TEXT NOT NULL,
  "timeLogApprovalId" TEXT NOT NULL,
  "timeLogId"         TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "employeeId"        TEXT,
  "employeeEmail"     TEXT,
  "employeeFirstName" TEXT,
  "employeeLastName"  TEXT,
  "punchType"         TEXT,
  "segmentType"       TEXT,
  "approvalStatus"    TEXT,
  "timeIn"            TIMESTAMPTZ,
  "timeOut"           TIMESTAMPTZ,
  "approvedClockIn"   TIMESTAMPTZ,
  "approvedClockOut"  TIMESTAMPTZ,
  "actualHours"       DECIMAL(6,2),
  "scheduledHours"    DECIMAL(6,2),
  "snapshotTakenAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "LeaveDayArchive" (
  id                BIGSERIAL PRIMARY KEY,
  "periodStart"     DATE NOT NULL,
  "periodEnd"       DATE NOT NULL,
  "companyId"       TEXT NOT NULL,
  "leaveDayId"      TEXT NOT NULL,
  "leaveId"         TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "employeeId"      TEXT,
  "employeeEmail"   TEXT,
  "leaveType"       TEXT,
  "date"            DATE NOT NULL,
  "isPaid"          BOOLEAN NOT NULL,
  "hours"           DECIMAL(6,2) NOT NULL,
  "leaveStatus"     TEXT,
  "snapshotTakenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PayrollExport" (
  id              BIGSERIAL PRIMARY KEY,
  "periodStart"   DATE NOT NULL,
  "periodEnd"     DATE NOT NULL,
  "companyId"     TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "employeeId"    TEXT,
  "employeeName"  TEXT,
  "regularHours"  DECIMAL(8,2) NOT NULL DEFAULT 0,
  "otHours"       DECIMAL(8,2) NOT NULL DEFAULT 0,
  "driverHours"   DECIMAL(8,2) NOT NULL DEFAULT 0,
  "trainingHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
  "ptoHours"      DECIMAL(8,2) NOT NULL DEFAULT 0,
  "generatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PayrollExportBatch" (
  id              BIGSERIAL PRIMARY KEY,
  "companyId"     TEXT NOT NULL,
  "periodStart"   DATE NOT NULL,
  "periodEnd"     DATE NOT NULL,
  "employeeCount" INT NOT NULL DEFAULT 0,
  "payload"       JSONB NOT NULL,
  "generatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "CutoffPunchArchive_userId_idx" ON "CutoffPunchArchive"("userId");
CREATE INDEX IF NOT EXISTS "CutoffPunchArchive_period_idx" ON "CutoffPunchArchive"("companyId", "periodStart", "periodEnd");
CREATE INDEX IF NOT EXISTS "LeaveDayArchive_userId_idx"    ON "LeaveDayArchive"("userId");
CREATE INDEX IF NOT EXISTS "LeaveDayArchive_period_idx"    ON "LeaveDayArchive"("companyId", "periodStart", "periodEnd");
CREATE INDEX IF NOT EXISTS "PayrollExport_userId_idx"      ON "PayrollExport"("userId");
CREATE INDEX IF NOT EXISTS "PayrollExport_period_idx"      ON "PayrollExport"("companyId", "periodStart", "periodEnd");
CREATE INDEX IF NOT EXISTS "PayrollExportBatch_period_idx" ON "PayrollExportBatch"("companyId", "periodStart", "periodEnd");
