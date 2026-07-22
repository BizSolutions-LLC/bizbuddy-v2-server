-- ============================================================
-- BB-040 BACKFILL — STAGE 2 — ALL other affected DRIVER_AIDE employees
-- Purpose: same correction as Stage 1 (docs/sql/beverly_brazil_bb040_backfill_stage1.sql),
--          applied to every TimeLog where all 3 DRIVER_AIDE segments are approved
--          but the TimeLog.*SegmentHours display copy no longer matches the
--          approved TimeLogApproval.actualHours (clobbered by a routine cutoff
--          period "Sync" action prior to the BB-040 code fix landing).
--
-- Does NOT touch TimeLogApproval — never wrong, always the payroll source of truth.
-- Run DETECTION first and review the full list before running the fix.
-- ============================================================

-- ── DETECTION — every affected TimeLog, across all companies ──
-- One row per mismatched segment. Same employee/day will appear up to 3 times
-- (once per segment) if more than one segment is off.
SELECT
  u."companyId",
  up."firstName" || ' ' || up."lastName"                          AS employee_name,
  u.email,
  tl.id                                                           AS timelog_id,
  (tl."timeIn" AT TIME ZONE c."timeZone")::date                   AS punch_date,
  tla."segmentType",
  tla."actualHours"                                                AS approval_actual_hours,
  CASE tla."segmentType"
    WHEN 'driver_am' THEN tl."driverAmSegmentHours"
    WHEN 'regular'   THEN tl."regularSegmentHours"
    WHEN 'driver_pm' THEN tl."driverPmSegmentHours"
  END                                                              AS timelog_stored_hours,
  tl."netWorkedHours"                                             AS timelog_net_worked_before
FROM "TimeLogApproval" tla
JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
JOIN "User" u      ON u.id = tl."userId"
JOIN "UserProfile" up ON up."userId" = u.id
JOIN "Company" c   ON c.id = u."companyId"
WHERE tl."punchType" = 'DRIVER_AIDE'
  AND tla.status = 'approved'
  -- all 3 siblings approved (same guard as syncApprovedSegmentsToTimeLog)
  AND NOT EXISTS (
    SELECT 1 FROM "TimeLogApproval" sib
    WHERE sib."timeLogId" = tla."timeLogId" AND sib.status != 'approved'
  )
  AND (
    SELECT COUNT(*) FROM "TimeLogApproval" sib2 WHERE sib2."timeLogId" = tla."timeLogId"
  ) = 3
  AND tla."actualHours" IS DISTINCT FROM (
    CASE tla."segmentType"
      WHEN 'driver_am' THEN tl."driverAmSegmentHours"
      WHEN 'regular'   THEN tl."regularSegmentHours"
      WHEN 'driver_pm' THEN tl."driverPmSegmentHours"
    END
  )
ORDER BY u."companyId", employee_name, punch_date, tla."segmentType";


-- ── THE FIX — transactional, review RETURNING before committing ──
BEGIN;

WITH approved_segments AS (
  SELECT
    tla."timeLogId",
    MAX(CASE WHEN tla."segmentType" = 'driver_am' THEN tla."actualHours" END) AS driver_am_hours,
    MAX(CASE WHEN tla."segmentType" = 'regular'   THEN tla."actualHours" END) AS regular_hours,
    MAX(CASE WHEN tla."segmentType" = 'driver_pm' THEN tla."actualHours" END) AS driver_pm_hours,
    COUNT(*) FILTER (WHERE tla.status != 'approved')                          AS non_approved_count,
    COUNT(*)                                                                  AS segment_count
  FROM "TimeLogApproval" tla
  JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
  WHERE tl."punchType" = 'DRIVER_AIDE'
  GROUP BY tla."timeLogId"
)
UPDATE "TimeLog" tl
SET
  "driverAmSegmentHours" = aps.driver_am_hours,
  "regularSegmentHours"  = aps.regular_hours,
  "driverPmSegmentHours" = aps.driver_pm_hours,
  "netWorkedHours"       = ROUND(
    (COALESCE(aps.driver_am_hours, 0) + COALESCE(aps.regular_hours, 0) + COALESCE(aps.driver_pm_hours, 0))::numeric,
    2
  )
FROM approved_segments aps
WHERE tl.id = aps."timeLogId"
  AND aps.non_approved_count = 0
  AND aps.segment_count = 3
  -- only touch rows that actually differ — avoids no-op writes/updatedAt churn
  AND (
    tl."driverAmSegmentHours" IS DISTINCT FROM aps.driver_am_hours OR
    tl."regularSegmentHours"  IS DISTINCT FROM aps.regular_hours  OR
    tl."driverPmSegmentHours" IS DISTINCT FROM aps.driver_pm_hours
  )
RETURNING
  tl.id                     AS timelog_id,
  tl."driverAmSegmentHours",
  tl."regularSegmentHours",
  tl."driverPmSegmentHours",
  tl."netWorkedHours";

-- Review every row in the RETURNING output above against the DETECTION query
-- results (should be the same set of timelog_ids). If it all looks right:
-- COMMIT;
-- Otherwise:
-- ROLLBACK;
