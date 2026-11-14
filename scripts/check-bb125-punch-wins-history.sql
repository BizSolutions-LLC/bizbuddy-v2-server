-- scripts/check-bb125-punch-wins-history.sql
--
-- BB-125 — READ-ONLY audit of every past "punch wins over leave" resolution
-- (the "Automatically Resolve Punch-vs-Leave Conflicts" setting or Honor Punch),
-- all companies. Runs inside a READ ONLY transaction and ends with ROLLBACK:
-- it cannot change anything.
--
-- Why: before BB-125 the punch-wins path had three bugs —
--   (a) Driver/Aide punches were snapped to ONE shift window and the TimeLog's
--       times were overwritten (Josie Soriano Nov 9: 6:51→2:45 became 6:45→8:00;
--       Albert Dalere 7/27 + 7/28 show the same 6:45→8:00 fingerprint),
--   (b) the leave lookup missed noon-stored leave dates, so the leave often
--       stayed approved and paid (Marites Fernandez 10-30),
--   (c) when the lookup did work, the WHOLE leave was cancelled, even days the
--       employee never punched.
--
-- Times are shown in each company's time zone. Leave dates are calendar dates
-- (their UTC date part), same as the server.
--
-- Sections:
--   1. Every punch resolved "punch takes precedence" — one row per punch, raw vs
--      current times, flag DA_SHORTENED when a Driver/Aide punch lost time.
--   2. Every day of every leave reverted/cancelled by punch-wins — was that day
--      actually punched? Flag REVERTED_NO_PUNCH (leave lost on a day not worked).
--   3. Leaves STILL approved on a day with an approved punch — not reverted
--      (Marites-type, possibly paid twice). Flag by how the punch was approved.
--   4. Summary counts per company.
--
-- Usage: run it in your SQL client (psql -f, TablePlus, etc.) against the DB.

BEGIN TRANSACTION READ ONLY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Punches resolved "punch takes precedence"
-- ─────────────────────────────────────────────────────────────────────────────
WITH honored AS (
  SELECT
    tl.id                                         AS time_log_id,
    tl."userId",
    tl."punchType",
    tl."timeIn", tl."timeOut", tl."originalTimeIn", tl."originalTimeOut",
    tl."autoClockOut",
    tl."netWorkedHours",
    MIN(tla."approvedAt")                         AS resolved_at,
    BOOL_AND(tla."approvedBy" IS NULL)            AS automatic,
    STRING_AGG(COALESCE(tla."segmentType", 'regular') || '=' || tla.status
               || COALESCE(' ' || tla."actualHours"::text || 'h', ''), ', '
               ORDER BY tla."segmentType")         AS segments,
    MAX(tla."cutoffPeriodId")                     AS cutoff_period_id
  FROM "TimeLogApproval" tla
  JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
  WHERE tla.notes ILIKE 'Conflict resolved%punch takes precedence%'
  GROUP BY tl.id
)
SELECT
  c.name                                                                    AS company,
  TRIM(COALESCE(p."firstName", '') || ' ' || COALESCE(p."lastName", ''))   AS employee,
  (h."timeIn" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'))::date AS punch_date,
  h."punchType"                                                             AS punch_type,
  CASE WHEN h.automatic THEN 'auto' ELSE 'manual' END                       AS resolved_by,
  TO_CHAR(h.resolved_at AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'YYYY-MM-DD HH24:MI') AS resolved_at,
  TO_CHAR(COALESCE(h."originalTimeIn", h."timeIn") AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI')
    || ' → ' ||
  COALESCE(TO_CHAR(COALESCE(h."originalTimeOut", h."timeOut") AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI'), 'open') AS raw_punch,
  TO_CHAR(h."timeIn" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI')
    || ' → ' ||
  COALESCE(TO_CHAR(h."timeOut" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI'), 'open') AS current_punch,
  ROUND((EXTRACT(EPOCH FROM (COALESCE(h."originalTimeOut", h."timeOut") - COALESCE(h."originalTimeIn", h."timeIn"))) / 3600)::numeric, 2) AS raw_hours,
  ROUND((EXTRACT(EPOCH FROM (h."timeOut" - h."timeIn")) / 3600)::numeric, 2) AS current_hours,
  h."netWorkedHours"                                                        AS net_worked_hours,
  h."autoClockOut"                                                          AS auto_clock_out,
  h.segments,
  cp.status                                                                 AS cutoff_status,
  CASE
    WHEN h."punchType"::text LIKE 'DRIVER_AIDE%'
     AND h."originalTimeOut" IS NOT NULL AND h."timeOut" IS NOT NULL
     AND h."timeOut" < h."originalTimeOut" - INTERVAL '30 minutes'         THEN 'DA_SHORTENED'
    WHEN h."punchType"::text LIKE 'DRIVER_AIDE%'                            THEN 'DA_CHECK'
    ELSE ''
  END                                                                       AS flag,
  u.email,
  h.time_log_id
FROM honored h
JOIN "User" u              ON u.id = h."userId"
LEFT JOIN "UserProfile" p  ON p."userId" = u.id
LEFT JOIN "Company" c      ON c.id = u."companyId"
LEFT JOIN "CutoffPeriod" cp ON cp.id = h.cutoff_period_id
ORDER BY company, employee, punch_date;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Each day of each leave reverted / cancelled by punch-wins: was it punched?
-- ─────────────────────────────────────────────────────────────────────────────
WITH pw_leaves AS (
  SELECT l.*
  FROM "Leave" l
  WHERE l.status = 'reverted'
     OR (l.status = 'cancelled' AND l."approverComments" ILIKE '%conflict resolved in favour of punch%')
),
days AS (
  SELECT l.id AS leave_id, l."userId", l.status AS leave_status, l."leaveType", l."policyId",
         l."isPaid", l."includeWeekends",
         gs::date AS day
  FROM pw_leaves l
  CROSS JOIN LATERAL generate_series(
    (l."startDate" AT TIME ZONE 'UTC')::date,
    (l."endDate"   AT TIME ZONE 'UTC')::date,
    INTERVAL '1 day'
  ) gs
)
SELECT
  c.name                                                                  AS company,
  TRIM(COALESCE(p."firstName", '') || ' ' || COALESCE(p."lastName", '')) AS employee,
  COALESCE(lp."leaveType", d."leaveType")                                 AS leave_type,
  d.leave_status,
  d.day,
  TO_CHAR(d.day, 'Dy')                                                    AS dow,
  ld.leave_day_hours,
  ld.leave_day_paid,
  ld.leave_day_reverted,
  pun.punches,
  pun.approval_statuses,
  CASE
    WHEN pun.punches IS NULL AND (ld.leave_day_hours IS NOT NULL OR EXTRACT(ISODOW FROM d.day) < 6)
      THEN 'REVERTED_NO_PUNCH'
    WHEN pun.punches IS NOT NULL THEN 'worked'
    ELSE ''
  END                                                                     AS flag,
  d.leave_id
FROM days d
JOIN "User" u              ON u.id = d."userId"
LEFT JOIN "UserProfile" p  ON p."userId" = u.id
LEFT JOIN "Company" c      ON c.id = u."companyId"
LEFT JOIN "LeavePolicy" lp ON lp.id = COALESCE(d."policyId", d."leaveType")
LEFT JOIN LATERAL (
  SELECT SUM(x.hours)                                                         AS leave_day_hours,
         BOOL_OR(x."isPaid")                                                  AS leave_day_paid,
         BOOL_AND(x."revertedAt" IS NOT NULL)                                 AS leave_day_reverted
  FROM "LeaveDay" x
  WHERE x."leaveId" = d.leave_id AND x.date = d.day
) ld ON TRUE
LEFT JOIN LATERAL (
  SELECT STRING_AGG(
           TO_CHAR(tl."timeIn" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI') || '→' ||
           COALESCE(TO_CHAR(COALESCE(tl."originalTimeOut", tl."timeOut") AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI'), 'open')
           || ' ' || tl."punchType", ' + ' ORDER BY tl."timeIn")                AS punches,
         STRING_AGG(DISTINCT a.status, ',')                                     AS approval_statuses
  FROM "TimeLog" tl
  LEFT JOIN "TimeLogApproval" a ON a."timeLogId" = tl.id
  WHERE tl."userId" = d."userId"
    AND (COALESCE(tl."originalTimeIn", tl."timeIn") AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'))::date = d.day
) pun ON TRUE
ORDER BY company, employee, d.leave_id, d.day;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Leaves STILL approved on a day that also has an approved punch
--    (not reverted — the employee may be paid both the punch and the leave)
-- ─────────────────────────────────────────────────────────────────────────────
WITH leave_days AS (
  -- decided leaves: their counted LeaveDay rows
  SELECT l.id AS leave_id, l."userId", l."leaveType", l."policyId", ld.date AS day,
         SUM(ld.hours) AS hours, BOOL_OR(ld."isPaid") AS paid, l."excludedShiftIds"
  FROM "Leave" l
  JOIN "LeaveDay" ld ON ld."leaveId" = l.id AND ld."revertedAt" IS NULL
  WHERE l.status = 'approved'
  GROUP BY l.id, ld.date
  UNION ALL
  -- legacy leaves with no LeaveDay rows: every date in range
  SELECT l.id, l."userId", l."leaveType", l."policyId", gs::date, NULL, l."isPaid", l."excludedShiftIds"
  FROM "Leave" l
  CROSS JOIN LATERAL generate_series((l."startDate" AT TIME ZONE 'UTC')::date, (l."endDate" AT TIME ZONE 'UTC')::date, INTERVAL '1 day') gs
  WHERE l.status = 'approved' AND NOT EXISTS (SELECT 1 FROM "LeaveDay" x WHERE x."leaveId" = l.id)
)
SELECT
  c.name                                                                  AS company,
  TRIM(COALESCE(p."firstName", '') || ' ' || COALESCE(p."lastName", '')) AS employee,
  COALESCE(lp."leaveType", d."leaveType")                                 AS leave_type,
  d.day,
  d.hours                                                                 AS leave_hours,
  d.paid                                                                  AS leave_paid,
  TO_CHAR(tl."timeIn" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI') || '→' ||
  COALESCE(TO_CHAR(tl."timeOut" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'), 'HH24:MI'), 'open') AS punch,
  tl."punchType"                                                          AS punch_type,
  STRING_AGG(DISTINCT COALESCE(a.notes, '(no note)'), ' | ')              AS approval_notes,
  BOOL_AND(a."approvedBy" IS NULL)                                        AS approved_automatically,
  MAX(cp.status)                                                          AS cutoff_status,
  CASE
    WHEN JSONB_ARRAY_LENGTH(COALESCE(d."excludedShiftIds", '[]'::jsonb)) > 0 THEN 'CHECK_EXCLUDED_SHIFT'
    WHEN BOOL_OR(a.notes ILIKE 'Conflict resolved%punch takes precedence%') THEN 'AUTO_REVERT_FAILED'
    ELSE 'APPROVED_OVER_LEAVE'
  END                                                                     AS flag,
  d.leave_id,
  tl.id                                                                   AS time_log_id
FROM leave_days d
JOIN "User" u              ON u.id = d."userId"
LEFT JOIN "UserProfile" p  ON p."userId" = u.id
LEFT JOIN "Company" c      ON c.id = u."companyId"
LEFT JOIN "LeavePolicy" lp ON lp.id = COALESCE(d."policyId", d."leaveType")
JOIN "TimeLog" tl
  ON tl."userId" = d."userId"
 AND (tl."timeIn" AT TIME ZONE COALESCE(c."timeZone", 'America/Los_Angeles'))::date = d.day
JOIN "TimeLogApproval" a ON a."timeLogId" = tl.id AND a.status IN ('approved', 'resolved')
LEFT JOIN "CutoffPeriod" cp ON cp.id = a."cutoffPeriodId"
GROUP BY c.name, p."firstName", p."lastName", lp."leaveType", d."leaveType", d.day, d.hours, d.paid,
         tl.id, tl."timeIn", tl."timeOut", tl."punchType", d."excludedShiftIds", d.leave_id, c."timeZone"
ORDER BY company, employee, d.day;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Summary per company
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  c.name AS company,
  COUNT(DISTINCT tl.id) FILTER (WHERE tla.notes ILIKE 'Conflict resolved%punch takes precedence%')                     AS punches_honored,
  COUNT(DISTINCT tl.id) FILTER (WHERE tla.notes ILIKE 'Conflict resolved%punch takes precedence%'
                                  AND tl."punchType"::text LIKE 'DRIVER_AIDE%')                                         AS da_punches_honored,
  COUNT(DISTINCT tl.id) FILTER (WHERE tla.notes ILIKE 'Conflict resolved%punch takes precedence%'
                                  AND tl."punchType"::text LIKE 'DRIVER_AIDE%'
                                  AND tl."originalTimeOut" IS NOT NULL AND tl."timeOut" < tl."originalTimeOut" - INTERVAL '30 minutes') AS da_shortened,
  COUNT(DISTINCT tl.id) FILTER (WHERE tla.notes ILIKE 'Conflict resolved%leave takes precedence%')                     AS punches_excluded_for_leave
FROM "TimeLogApproval" tla
JOIN "TimeLog" tl ON tl.id = tla."timeLogId"
JOIN "User" u     ON u.id = tl."userId"
JOIN "Company" c  ON c.id = u."companyId"
WHERE tla.notes ILIKE 'Conflict resolved%'
GROUP BY c.name
ORDER BY c.name;

ROLLBACK;
