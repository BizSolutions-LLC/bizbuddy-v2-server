-- ============================================================
-- Leave Requests Overview
-- ============================================================

-- ── 1. Summary count by status ───────────────────────────────
SELECT
  status,
  COUNT(*) AS total
FROM "Leave"
GROUP BY status
ORDER BY status;


-- ── 2. All leave requests with requester + approver details ──
SELECT
  l.id                                                            AS leave_id,
  l.status,
  l."leaveType",
  l."isPaid",
  l."startDate"  AT TIME ZONE 'America/Los_Angeles'              AS start_date,
  l."endDate"    AT TIME ZONE 'America/Los_Angeles'              AS end_date,
  -- Requester
  u.id                                                            AS user_id,
  u.email                                                         AS user_email,
  up."firstName"                                                  AS user_first,
  up."lastName"                                                   AS user_last,
  up.username                                                     AS username,
  -- Approver (nullable)
  l."approverId",
  ap.email                                                        AS approver_email,
  aup."firstName"                                                 AS approver_first,
  aup."lastName"                                                  AS approver_last,
  -- Secondary approver (nullable)
  l."secondaryApproverId",
  -- Reason / comments
  l."leaveReason",
  l."approverComments",
  l."secondaryApproverComments",
  l."createdAt"  AT TIME ZONE 'America/Los_Angeles'              AS requested_at
FROM "Leave" l
JOIN "User"         u   ON u.id        = l."userId"
LEFT JOIN "UserProfile" up  ON up."userId" = u.id
LEFT JOIN "User"        ap  ON ap.id       = l."approverId"
LEFT JOIN "UserProfile" aup ON aup."userId" = ap.id
ORDER BY l."createdAt" DESC;


-- ── 3. Summary by user — how many requests per person ────────
SELECT
  u.email,
  up."firstName",
  up."lastName",
  COUNT(*)                                                        AS total_requests,
  COUNT(*) FILTER (WHERE l.status = 'pending')                   AS pending,
  COUNT(*) FILTER (WHERE l.status = 'approved')                  AS approved,
  COUNT(*) FILTER (WHERE l.status = 'rejected')                  AS rejected
FROM "Leave" l
JOIN "User"         u  ON u.id        = l."userId"
LEFT JOIN "UserProfile" up ON up."userId" = u.id
GROUP BY u.email, up."firstName", up."lastName"
ORDER BY total_requests DESC;


-- ── 4. Summary by leave type + status ────────────────────────
SELECT
  "leaveType",
  status,
  COUNT(*)                                                        AS total
FROM "Leave"
GROUP BY "leaveType", status
ORDER BY "leaveType", status;
