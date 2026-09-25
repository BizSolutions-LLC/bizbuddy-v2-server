-- Disbursement module: payout-provider placeholders on employee payroll details.
ALTER TABLE "EmployeePayrollDetails"
  ADD COLUMN IF NOT EXISTS "payoutProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutProviderAccountId" TEXT;

-- One non-cancelled disbursement batch per payroll run.
-- Prisma cannot express a partial unique index in schema.prisma; this is the
-- database-level duplicate-payment guard. Application code also sets
-- DisbursementBatch.activePayrollRunKey = payrollRunId while the batch is active.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'DisbursementBatch'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS disbursement_batch_one_active_per_run
      ON "DisbursementBatch" ("payrollRunId")
      WHERE status <> 'CANCELLED';
  END IF;
END $$;
