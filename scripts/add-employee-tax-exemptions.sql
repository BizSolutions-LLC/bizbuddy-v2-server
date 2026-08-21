-- Migration: Per-employee tax exemption toggles.
--
-- Adds five YES/NO exemption flags on EmployeePayrollDetails so an admin
-- can mark an employee exempt from each US payroll tax type:
--   federalIncomeTaxExempt  — Federal Income Tax
--   socialSecurityExempt    — Social Security (FICA SS)
--   medicareExempt          — Medicare
--   caPitExempt             — CA PIT (state income tax)
--   caSdiExempt             — CA SDI
--
-- skipFicaMedicare is kept for older clients. It is now the conjunction
-- of socialSecurityExempt AND medicareExempt. Existing rows that already
-- had skipFicaMedicare = true are backfilled so the two new flags match.
--
-- Safe for a live table: new columns are NOT NULL DEFAULT false, so every
-- existing row that was not skipFicaMedicare stays "not exempt."

ALTER TABLE "EmployeePayrollDetails"
  ADD COLUMN IF NOT EXISTS "federalIncomeTaxExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "socialSecurityExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "medicareExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "caPitExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "caSdiExempt" BOOLEAN NOT NULL DEFAULT false;

UPDATE "EmployeePayrollDetails"
SET
  "socialSecurityExempt" = true,
  "medicareExempt" = true
WHERE "skipFicaMedicare" = true;
