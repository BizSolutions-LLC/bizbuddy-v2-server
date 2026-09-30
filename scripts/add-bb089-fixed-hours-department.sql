-- Migration: BB-089 — fixed-hours departments (e.g. SV always gets 80h per cutoff)
--
-- Safe for live tables with existing rows:
--   - Department gets two columns with defaults (off / 80.00) — every existing
--     department keeps behaving exactly as before until an admin turns it on.
--   - CutoffFixedHours is a brand new table; nothing to backfill. Rows are
--     created by the app the next time an open cutoff's review page loads.
--
-- After running: npx prisma generate

ALTER TABLE "Department"
  ADD COLUMN "fixedHoursEnabled"   BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN "fixedHoursPerCutoff" DECIMAL(6,2) NOT NULL DEFAULT 80;

CREATE TABLE "CutoffFixedHours" (
  "id"             TEXT           NOT NULL,
  "cutoffPeriodId" TEXT           NOT NULL,
  "userId"         TEXT           NOT NULL,
  "hours"          DECIMAL(6,2)   NOT NULL,
  "status"         TEXT           NOT NULL DEFAULT 'approved',
  "editedBy"       TEXT,
  "editedAt"       TIMESTAMPTZ(6),
  "notes"          TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "CutoffFixedHours_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CutoffFixedHours"
  ADD CONSTRAINT "CutoffFixedHours_cutoffPeriodId_fkey"
    FOREIGN KEY ("cutoffPeriodId") REFERENCES "CutoffPeriod"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "CutoffFixedHours_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "CutoffFixedHours_editedBy_fkey"
    FOREIGN KEY ("editedBy") REFERENCES "User"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "CutoffFixedHours_cutoffPeriodId_userId_key" ON "CutoffFixedHours"("cutoffPeriodId", "userId");
CREATE INDEX "CutoffFixedHours_cutoffPeriodId_idx" ON "CutoffFixedHours"("cutoffPeriodId");
CREATE INDEX "CutoffFixedHours_userId_idx" ON "CutoffFixedHours"("userId");
