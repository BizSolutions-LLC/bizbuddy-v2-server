-- BB-066: department scoping for PayrollExport + a per-period upsert target
-- for PayrollExportBatch.
--
-- Cutoff periods lock one department at a time (see Cutoff Periods list —
-- each row is a single department's period). PayrollExport needs a
-- departmentId so a department's lock/re-lock can delete+reinsert just its
-- own rows without touching other departments' already-computed rows for the
-- same companyId+period. PayrollExportBatch needs a unique index on
-- (companyId, periodStart, periodEnd) so it can be upserted — one row per
-- period, always the latest merged JSON across every department that has
-- locked so far ("take-latest", no history kept).
--
-- Purely additive, safe to run any time (IF NOT EXISTS throughout):
--  - Existing PayrollExport rows (written by the one-time Jul 8-21 script,
--    before departmentId existed) get departmentId = NULL — harmless, that
--    prior run predates per-department scoping entirely.
--  - No existing PayrollExportBatch rows should collide on the new unique
--    index (the one prior manual run wrote a single row), but if it ever did,
--    the ALTER would fail loudly rather than silently drop data — check for
--    duplicate (companyId, periodStart, periodEnd) rows first if this errors.

ALTER TABLE "PayrollExport" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;

CREATE INDEX IF NOT EXISTS "PayrollExport_dept_period_idx"
  ON "PayrollExport"("companyId", "periodStart", "periodEnd", "departmentId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollExportBatch_company_period_unique"
  ON "PayrollExportBatch"("companyId", "periodStart", "periodEnd");
