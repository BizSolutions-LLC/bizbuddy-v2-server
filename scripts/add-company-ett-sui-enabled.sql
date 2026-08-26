-- Migration: Company-wide employer ETT / SUI toggles.
--
-- Adds two independent YES/NO flags on Company so an admin can enable or
-- disable employer Employment Training Tax (ETT) and State Unemployment
-- Insurance (SUI) for the whole company:
--   ettEnabled  — Employment Training Tax
--   suiEnabled  — State Unemployment Insurance
--
-- Default true so existing companies keep employer ETT/SUI on until an
-- admin turns a flag off. Safe for a live table: new columns are
-- NOT NULL DEFAULT true.

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "ettEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "suiEnabled" BOOLEAN NOT NULL DEFAULT true;
