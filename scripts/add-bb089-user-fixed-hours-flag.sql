-- Migration: BB-089 follow-up — per-employee fixed-hours switch
--
-- Run AFTER scripts/add-bb089-fixed-hours-department.sql (either order is
-- fine if that one was already applied). Purely additive: every existing user
-- defaults to false (punch-based), so nobody changes to fixed hours until an
-- admin turns them on individually.
--
-- After running: npx prisma generate

ALTER TABLE "User"
  ADD COLUMN "fixedHoursEnabled" BOOLEAN NOT NULL DEFAULT false;
