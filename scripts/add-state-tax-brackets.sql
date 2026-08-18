-- Migration: Configurable per-company state income tax brackets.
--
-- Replaces the flat stateIncomeTaxRate percentage on PayrollConfiguration
-- with a proper bracket table, mirroring the FederalTaxRate table added by
-- scripts/add-federal-tax-brackets.sql — state withholding varies by annual
-- gross income and filing status rather than a single flat rate.
--
-- Supported filing statuses (per business decision, same as Federal):
-- single, married_filing_separately, head_of_household. "married" is kept
-- in the MaritalStatus enum for backward compatibility with existing
-- EmployeePayrollDetails rows, and is treated as equivalent to
-- married_filing_separately for withholding purposes (application-level
-- mapping, same as Federal). "married_filing_jointly" is intentionally not
-- supported, consistent with FederalTaxRate's scope.
--
-- Safe for a live table with existing rows:
--   - Dropping stateIncomeTaxRate is safe: FICA/Medicare/SDI/FUTA stay flat
--     rates on PayrollConfiguration — only state income tax moves to
--     brackets, same pattern as the federal migration.
--   - StateIncomeTaxRate is a brand new table — no backfill needed.
--     Application code seeds sensible default bracket rows for a company
--     the first time it's read with none configured yet.

ALTER TABLE "PayrollConfiguration"
  DROP COLUMN IF EXISTS "stateIncomeTaxRate";

CREATE TABLE IF NOT EXISTS "StateIncomeTaxRate" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "filingStatus" "MaritalStatus" NOT NULL,
  "minAnnualIncome" DECIMAL(12, 2) NOT NULL,
  "maxAnnualIncome" DECIMAL(12, 2),
  "rate" DECIMAL(5, 2) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "StateIncomeTaxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StateIncomeTaxRate_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "StateIncomeTaxRate_companyId_filingStatus_idx"
  ON "StateIncomeTaxRate" ("companyId", "filingStatus");
