-- Migration: Configurable per-company deduction tax rates on PayrollConfiguration
-- Adds Federal Income Tax, State Income Tax, FICA, Medicare, and SDI percentage
-- columns so these no longer have to be hardcoded per environment/client build.
--
-- Stored as plain percentage numbers (e.g. 12 means 12%), matching the
-- existing futaRate column's convention on this same table.
--
-- Safe for a live table with existing rows:
--   - Every column has a NOT NULL DEFAULT matching the values currently
--     hardcoded in payrollSystemController.js / docs/PAYROLL_SYSTEM.md, so
--     every existing company row gets the same effective rates it has today
--     with no behavior change on deploy. Admins can override per company
--     afterwards.

ALTER TABLE "PayrollConfiguration"
  ADD COLUMN IF NOT EXISTS "federalIncomeTaxRate" DECIMAL(5, 2) NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS "stateIncomeTaxRate" DECIMAL(5, 2) NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "ficaRate" DECIMAL(5, 2) NOT NULL DEFAULT 6.2,
  ADD COLUMN IF NOT EXISTS "medicareRate" DECIMAL(5, 2) NOT NULL DEFAULT 1.45,
  ADD COLUMN IF NOT EXISTS "sdiRate" DECIMAL(5, 2) NOT NULL DEFAULT 1.1;
