-- Add affectedShifts column to Leave table
-- Run once, then delete this file and run: npx prisma generate
ALTER TABLE "Leave" ADD COLUMN IF NOT EXISTS "affectedShifts" JSONB;
