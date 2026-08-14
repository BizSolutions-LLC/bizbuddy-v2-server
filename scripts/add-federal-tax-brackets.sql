-- Migration: Configurable per-company federal income tax brackets.
--
-- Replaces the flat federalIncomeTaxRate percentage (added by
-- scripts/add-payroll-deduction-tax-rates.sql) with a proper bracket table,
-- since federal withholding varies by annual gross income and filing status
-- rather than a single flat rate. State/FICA/Medicare/SDI stay flat rates on
-- PayrollConfiguration — only federal moves to brackets.
--
-- Supported filing statuses (per business decision): single,
-- married_filing_separately, head_of_household. "married" is kept in the
-- enum for backward compatibility with existing EmployeePayrollDetails rows
-- that already have it, but is no longer offered as a choice going forward.
--
-- Safe for a live table with existing rows:
--   - New enum value is purely additive — no existing row's maritalStatus
--     is touched.
--   - Dropping federalIncomeTaxRate is safe: it was never read by any live
--     calculation code (only written/returned), so no other table or query
--     depends on it. Uses IF EXISTS so this is safe to run whether or not
--     scripts/add-payroll-deduction-tax-rates.sql was ever applied.
--   - FederalTaxRate is a brand new table — no backfill needed. Application
--     code seeds sensible default bracket rows for a company the first time
--     it's read with none configured yet.

ALTER TYPE "MaritalStatus" ADD VALUE IF NOT EXISTS 'married_filing_separately';

ALTER TABLE "PayrollConfiguration"
  DROP COLUMN IF EXISTS "federalIncomeTaxRate";

CREATE TABLE IF NOT EXISTS "FederalTaxRate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "filingStatus" "MaritalStatus" NOT NULL,
  "minAnnualIncome" DECIMAL(12, 2) NOT NULL,
  "maxAnnualIncome" DECIMAL(12, 2),
  "rate" DECIMAL(5, 2) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "FederalTaxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FederalTaxRate_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "FederalTaxRate_companyId_filingStatus_idx"
  ON "FederalTaxRate" ("companyId", "filingStatus");
