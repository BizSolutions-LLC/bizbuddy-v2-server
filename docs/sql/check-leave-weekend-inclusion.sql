-- ============================================================
-- BB-054 — Which employees have approved/pending leaves that counted
-- weekend days (Sat/Sun) as deductible hours?
--
-- Read-only. All existing "Leave" rows default to includeWeekends = true
-- (the flag was only just added — it has no retroactive meaning for leaves
-- submitted before this feature existed), so filtering on that column
-- wouldn't distinguish anything here. Instead this looks at the actual
-- "LeaveDay" rows (the real day-by-day outcome created at approval time,
-- since BB-045) and flags any that land on a Saturday or Sunday with
-- hours > 0 — i.e., a weekend day that was actually paid or counted unpaid
-- against the employee, the exact scenario in the "Actual Day-by-Day
-- Outcome" panel screenshot (Sat Jul 25 / Sun Jul 26 both showing 8h Paid).
--
-- Caveat: "LeaveDay" rows only exist for leaves approved after that table
-- was introduced (BB-045) — older approved leaves have no rows here and
-- won't show up, not because they excluded weekends, just because the
-- day-by-day breakdown wasn't recorded yet for them.
-- ============================================================

-- ── 1. Every weekend LeaveDay row that counted hours, with employee + request context ──
SELECT
  u.email                                                          AS employee_email,
  up."firstName"                                                   AS employee_first,
  up."lastName"                                                    AS employee_last,
  l.id                                                              AS leave_id,
  l.status                                                          AS leave_status,
  l."leaveType",
  l."startDate" AT TIME ZONE 'America/Los_Angeles'                 AS leave_start,
  l."endDate"   AT TIME ZONE 'America/Los_Angeles'                 AS leave_end,
  ld.date                                                           AS weekend_date,
  TRIM(TO_CHAR(ld.date, 'Day'))                                     AS day_name,
  ld."isPaid"                                                       AS day_is_paid,
  ld.hours                                                          AS day_hours
FROM "LeaveDay" ld
JOIN "Leave" l          ON l.id     = ld."leaveId"
JOIN "User"  u          ON u.id     = l."userId"
LEFT JOIN "UserProfile" up ON up."userId" = u.id
WHERE EXTRACT(DOW FROM ld.date) IN (0, 6)   -- 0 = Sunday, 6 = Saturday
  AND ld.hours > 0
  AND l.status IN ('approved', 'pending', 'pending_secondary')
ORDER BY l.status, ld.date, u.email;


-- ── 2. Summary per employee — how many weekend days / hours counted, approved leaves only ──
SELECT
  u.email                                                          AS employee_email,
  up."firstName"                                                   AS employee_first,
  up."lastName"                                                    AS employee_last,
  COUNT(*)                                                          AS weekend_days_counted,
  SUM(ld.hours) FILTER (WHERE ld."isPaid")                          AS weekend_hours_paid,
  SUM(ld.hours) FILTER (WHERE NOT ld."isPaid")                      AS weekend_hours_unpaid
FROM "LeaveDay" ld
JOIN "Leave" l          ON l.id     = ld."leaveId"
JOIN "User"  u          ON u.id     = l."userId"
LEFT JOIN "UserProfile" up ON up."userId" = u.id
WHERE EXTRACT(DOW FROM ld.date) IN (0, 6)
  AND ld.hours > 0
  AND l.status = 'approved'
GROUP BY u.email, up."firstName", up."lastName"
ORDER BY weekend_days_counted DESC;


-- ── 3. Which specific approved leave requests span at least one counted weekend day (detailed) ──
-- "leaveType" on Leave stores either a LeavePolicy id (current convention) or a legacy
-- free-text name — COALESCE resolves the id to its policy name when it is one, same
-- fallback logic leaveController.js's resolveLeaveType() uses.
SELECT
  l.id                                                              AS leave_id,
  u.email                                                          AS employee_email,
  up."firstName"                                                   AS employee_first,
  up."lastName"                                                    AS employee_last,
  d.name                                                            AS department,
  COALESCE(lp."leaveType", l."leaveType")                          AS leave_type,
  l."isPaid"                                                       AS submitted_as_paid,
  l."leaveReason",
  au.email                                                         AS approver_email,
  l."startDate" AT TIME ZONE 'America/Los_Angeles'                 AS leave_start,
  l."endDate"   AT TIME ZONE 'America/Los_Angeles'                 AS leave_end,
  (l."endDate"::date - l."startDate"::date + 1)                    AS total_days,
  COUNT(ld.*)                                                       AS weekend_days_counted,
  SUM(ld.hours) FILTER (WHERE ld."isPaid")                          AS weekend_hours_paid,
  SUM(ld.hours) FILTER (WHERE NOT ld."isPaid")                      AS weekend_hours_unpaid,
  l."createdAt" AT TIME ZONE 'America/Los_Angeles'                 AS submitted_at
FROM "LeaveDay" ld
JOIN "Leave" l            ON l.id     = ld."leaveId"
JOIN "User"  u            ON u.id     = l."userId"
LEFT JOIN "UserProfile" up ON up."userId" = u.id
LEFT JOIN "Department"  d  ON d.id       = u."departmentId"
LEFT JOIN "LeavePolicy" lp ON lp.id      = l."leaveType"
LEFT JOIN "User"        au ON au.id      = l."approverId"
WHERE EXTRACT(DOW FROM ld.date) IN (0, 6)
  AND ld.hours > 0
  AND l.status = 'approved'
GROUP BY
  l.id, u.email, up."firstName", up."lastName", d.name,
  lp."leaveType", l."leaveType", l."isPaid", l."leaveReason",
  au.email, l."startDate", l."endDate", l."createdAt"
ORDER BY leave_start DESC;
