-- Migration: widen LeaveDay's unique constraint to allow a split day (BB-045).
--
-- Today a day where the balance runs out partway through falls entirely to
-- one side (paid or unpaid) — computeProration (leaveApprovalService.js)
-- requires a day's full hours to fit in the remaining balance, otherwise the
-- whole day goes unpaid, silently stranding any leftover balance smaller
-- than a full day (e.g. 3h left, 8h/day, the 3h never gets used).
--
-- Fix: the boundary day now splits into two LeaveDay rows sharing the same
-- date (one isPaid: true with the paid portion of the hours, one isPaid:
-- false with the remainder) instead of one row picking a side. That needs
-- the unique constraint widened from (leaveId, date) to
-- (leaveId, date, isPaid) — every existing row already satisfies the wider
-- constraint trivially (one row per date today), so this is safe on a live
-- table with no backfill required.
--
-- Prisma's default constraint/index name for @@unique([leaveId, date]) is
-- LeaveDay_leaveId_date_key — drop it and add the widened one.

ALTER TABLE "LeaveDay" DROP CONSTRAINT IF EXISTS "LeaveDay_leaveId_date_key";
ALTER TABLE "LeaveDay" ADD CONSTRAINT "LeaveDay_leaveId_date_isPaid_key" UNIQUE ("leaveId", "date", "isPaid");
