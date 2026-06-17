-- ============================================================
-- Overtime Requests Overview
-- ============================================================

-- ── 1. Summary count by status ───────────────────────────────
SELECT
  status,
  COUNT(*) AS total
FROM "Overtime"
GROUP BY status
ORDER BY status;


-- ── 2. All overtime requests with requester + company details ─
SELECT
  ot.id                                                           AS overtime_id,
  ot.status,
  ot."createdAt"                                                  AS requested_at,
  -- Requester
  requester.id                                                    AS requester_id,
  requester.username                                              AS requester_name,
  requester.email                                                 AS requester_email,
  -- Approver (nullable)
  approver.username                                               AS approver_name,
  -- Company / Department
  c.name                                                          AS company,
  d.name                                                          AS department,
  -- Hours
  ot."requestedHours",
  ot."lateHours",
  -- Reason / comments
  ot."requesterReason",
  ot."approverComments",
  -- Linked time log
  ot."timeLogId"
FROM "Overtime" ot
JOIN "User"    requester ON requester.id = ot."requesterId"
LEFT JOIN "User"    approver ON approver.id  = ot."approverId"
LEFT JOIN "Company" c        ON c.id         = ot."companyId"
LEFT JOIN "Department" d     ON d.id         = ot."departmentId"
ORDER BY ot."createdAt" DESC;


-- ── 3. Summary by company + status ───────────────────────────
SELECT
  c.name                                                          AS company,
  ot.status,
  COUNT(*)                                                        AS total,
  ROUND(SUM(ot."requestedHours")::numeric, 2)                    AS total_requested_hrs
FROM "Overtime" ot
LEFT JOIN "Company" c ON c.id = ot."companyId"
GROUP BY c.name, ot.status
ORDER BY c.name, ot.status;
