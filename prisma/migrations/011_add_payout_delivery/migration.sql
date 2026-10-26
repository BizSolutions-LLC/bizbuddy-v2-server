-- Standing choice for whether an employee is paid by bank or outside payroll.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayoutDelivery') THEN
    CREATE TYPE "PayoutDelivery" AS ENUM ('automatic', 'manual');
  END IF;
END $$;

ALTER TABLE "EmployeePayrollDetails"
  ADD COLUMN IF NOT EXISTS "payoutDelivery" "PayoutDelivery" NOT NULL DEFAULT 'automatic',
  ADD COLUMN IF NOT EXISTS "payoutAccountLinked" BOOLEAN NOT NULL DEFAULT false;
