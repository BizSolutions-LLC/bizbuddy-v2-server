-- ============================================================
-- BB-040 BACKJOB AUDIT — Beverly Brazil, Jul 13 Driver Day
-- Purpose: confirm whether TimeLog.*SegmentHours are stale (pre-approval)
--          vs TimeLogApproval.actualHours (payroll source of truth), per
--          docs/TIMELOG_MODULE.md "Source of Truth Hierarchy".
-- Read-only. Run each block independently or all at once.
-- ============================================================

-- ── 0. User lookup by name (adjust if multiple matches) ─────
SELECT
  u.id            AS user_id,
  u.username,
  u.email,
  u."departmentId",
  u."companyId",
  c."timeZone"    AS company_timezone
FROM "User" u
JOIN "UserProfile" up ON up."userId" = u.id
JOIN "Company" c       ON c.id = u."companyId"
WHERE up."firstName" ILIKE 'Beverly' AND up."lastName" ILIKE 'Brazil';


-- ── 1. TimeLog row(s) for Jul 13 (company-timezone calendar date) ──
-- Shows the CURRENT stored segment-hour columns — these are what
-- GET /api/timelogs returns directly, with NO grace/raw-approval logic.
SELECT
  tl.id                                                           AS timelog_id,
  tl."punchType",
  tl."timeIn"  AT TIME ZONE c."timeZone"                          AS clock_in_local,
  tl."timeOut" AT TIME ZONE c."timeZone"                          AS clock_out_local,
  tl."driverAmSegmentHours",
  tl."regularSegmentHours",
  tl."driverPmSegmentHours",
  tl."netWorkedHours",
  tl."rawOtMinutes",
  tl."isApproved",
  tl."calculatedAt",
  tl."updatedAt"                                                  AS timelog_updated_at
FROM "TimeLog" tl
JOIN "User" u    ON u.id = tl."userId"
JOIN "UserProfile" up ON up."userId" = u.id
JOIN "Company" c ON c.id = u."companyId"
WHERE up."firstName" ILIKE 'Beverly' AND up."lastName" ILIKE 'Brazil'
  AND (tl."timeIn" AT TIME ZONE c."timeZone")::date = '2026-07-13'
ORDER BY tl."timeIn";


-- ── 2. TimeLogApproval rows for that TimeLog — the payroll source ──
-- Shows all 3 DRIVER_AIDE segment approvals: status, actualHours,
-- segment window, and WHEN each was approved (approvedAt/updatedAt).
SELECT
  tla.id                                                          AS approval_id,
  tla."segmentType",
  tla.status,
  tla."approvalMode",
  tla."segmentStart" AT TIME ZONE c."timeZone"                    AS segment_start_local,
  tla."segmentEnd"   AT TIME ZONE c."timeZone"                    AS segment_end_local,
  tla."approvedClockIn"  AT TIME ZONE c."timeZone"                AS approved_in_local,
  tla."approvedClockOut" AT TIME ZONE c."timeZone"                AS approved_out_local,
  tla."actualHours",
  tla."scheduledHours",
  tla."cutoffPeriodId",
  tla."approvedAt",
  tla."updatedAt"                                                 AS approval_updated_at
FROM "TimeLogApproval" tla
JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
JOIN "User" u     ON u.id = tl."userId"
JOIN "UserProfile" up ON up."userId" = u.id
JOIN "Company" c  ON c.id = u."companyId"
WHERE up."firstName" ILIKE 'Beverly' AND up."lastName" ILIKE 'Brazil'
  AND (tl."timeIn" AT TIME ZONE c."timeZone")::date = '2026-07-13'
ORDER BY tla."segmentType";


-- ── 3. THE SMOKING GUN — side-by-side comparison ─────────────
-- Directly compares each segment's stored TimeLog column against the
-- approved TimeLogApproval.actualHours for the SAME segment. If sync-back
-- (syncApprovedSegmentsToTimeLog in daycareCutoffStrategy.js) ran
-- successfully after all 3 segments were approved, these should MATCH.
-- A MISMATCH means /api/timelogs (Punch Logs report) is serving stale,
-- pre-approval, non-grace-credited hours instead of the approved values.
SELECT
  tl.id                                                           AS timelog_id,
  tla."segmentType",
  tla.status,
  tla."actualHours"                                               AS approval_actual_hours,
  CASE tla."segmentType"
    WHEN 'driver_am' THEN tl."driverAmSegmentHours"
    WHEN 'regular'   THEN tl."regularSegmentHours"
    WHEN 'driver_pm' THEN tl."driverPmSegmentHours"
  END                                                              AS timelog_stored_hours,
  CASE
    WHEN tla.status = 'approved'
     AND tla."actualHours" IS DISTINCT FROM (
       CASE tla."segmentType"
         WHEN 'driver_am' THEN tl."driverAmSegmentHours"
         WHEN 'regular'   THEN tl."regularSegmentHours"
         WHEN 'driver_pm' THEN tl."driverPmSegmentHours"
       END
     )
    THEN '⚠ MISMATCH — TimeLog column is stale (sync-back did not apply)'
    ELSE '✓ matches'
  END                                                              AS flag,
  tl."netWorkedHours"                                             AS timelog_net_worked,
  (
    SELECT SUM(actual_hours) FROM (
      SELECT tla2."actualHours" AS actual_hours
      FROM "TimeLogApproval" tla2
      WHERE tla2."timeLogId" = tl.id AND tla2.status = 'approved'
    ) x
  )                                                                AS approvals_sum_actual_hours,
  tl."updatedAt"                                                  AS timelog_updated_at,
  tla."updatedAt"                                                 AS approval_updated_at,
  (tla."updatedAt" > tl."updatedAt")                               AS approval_written_after_timelog
FROM "TimeLogApproval" tla
JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
JOIN "User" u     ON u.id = tl."userId"
JOIN "UserProfile" up ON up."userId" = u.id
JOIN "Company" c  ON c.id = u."companyId"
WHERE up."firstName" ILIKE 'Beverly' AND up."lastName" ILIKE 'Brazil'
  AND (tl."timeIn" AT TIME ZONE c."timeZone")::date = '2026-07-13'
ORDER BY tla."segmentType";


-- ── 4. Edge case check — do all 3 segments share ONE cutoff period? ──
-- If a record was moved between cutoff periods (reopen/backfill), the
-- sync-back's WHERE cutoffPeriodId filter could see a partial sibling
-- set and never fire (or fire against the wrong set). This should
-- return exactly 1 distinct cutoffPeriodId for a clean case.
SELECT
  tl.id                                                           AS timelog_id,
  COUNT(DISTINCT tla."cutoffPeriodId")                            AS distinct_cutoff_periods,
  STRING_AGG(DISTINCT tla."cutoffPeriodId", ', ')                  AS cutoff_period_ids,
  COUNT(*) FILTER (WHERE tla.status != 'approved')                 AS non_approved_count
FROM "TimeLogApproval" tla
JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
JOIN "User" u     ON u.id = tl."userId"
JOIN "UserProfile" up ON up."userId" = u.id
WHERE up."firstName" ILIKE 'Beverly' AND up."lastName" ILIKE 'Brazil'
  AND (tl."timeIn" AT TIME ZONE (SELECT c."timeZone" FROM "Company" c WHERE c.id = u."companyId"))::date = '2026-07-13'
GROUP BY tl.id;
