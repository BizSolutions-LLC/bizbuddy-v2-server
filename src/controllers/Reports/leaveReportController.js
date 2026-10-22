// src/controllers/Reports/leaveReportController.js
//
// BB-098: leave reports as JSON for the client's Generate Report (Company
// Settings → Leave Settings). Admin/superadmin see the whole company;
// supervisors only their own department. See leaveReportService.

const { buildLeaveReport, ReportError } = require("@services/Reports/leaveReportService");

/**
 * GET /api/reports/leave
 *   ?type=summary|activity|expiration|requests|ledger   (required)
 *   &from=YYYY-MM-DD &to=YYYY-MM-DD                       (company timezone)
 *   &groupBy=month|quarter|year &basis=calendar|fiscal    (activity)
 *   &policyIds=a,b &departmentId=x &userIds=a,b &includeInactive=true
 *   &status=pending,approved,...                          (requests)
 *   &includeLifecycle=true                                (ledger)
 *   &expiringWithinDays=60                                (expiration)
 */
const getLeaveReport = async (req, res) => {
  try {
    const data = await buildLeaveReport(req.user, req.query);
    return res.status(200).json({ data });
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getLeaveReport error:", err);
    return res.status(500).json({ message: "Failed to build leave report." });
  }
};

module.exports = { getLeaveReport };
