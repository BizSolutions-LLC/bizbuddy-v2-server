-- Migration: Per-employee custom federal/state tax rate overrides.
--
-- Adds two nullable flat-percentage columns to EmployeePayrollDetails,
-- mirroring the precision of FederalTaxRate.rate / StateIncomeTaxRate.rate
-- (DECIMAL(5,2)). When null (the default), the employee's withholding
-- falls back to the company's bracket-based FederalTaxRate / 
-- StateIncomeTaxRate tables for their filing status. When set, the flat
-- rate overrides the bracket lookup entirely for that employee.
--
-- Safe for a live table with existing rows: both columns are nullable with
-- no default, so every existing row simply gets NULL (i.e. keeps using
-- company brackets) — no backfill needed.

ALTER TABLE "EmployeePayrollDetails"
  ADD COLUMN IF NOT EXISTS "customFederalRate" DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS "customStateRate" DECIMAL(5, 2);
