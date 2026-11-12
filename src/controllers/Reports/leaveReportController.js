// src/controllers/Reports/leaveReportController.js
//
// BB-098: leave reports as JSON for the client's Generate Report (Company
// Settings → Leave Settings). Admin/superadmin see the whole company;
// supervisors only their own department. See leaveReportService.

const moment = require("moment-timezone");
const { buildLeaveReport, ReportError } = require("@services/Reports/leaveReportService");
const { buildLeaveTemplateReport } = require("@services/Reports/leaveTemplateReportService");
const { generateLeaveReportXlsx } = require("@utils/generateLeaveReportXlsx");

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

/**
 * BB-106: GET /api/reports/leave/template — the "Leave Report" workbook
 * (docs/LeaveReport_Template.csv layout, one sheet per leave type).
 *   ?year=YYYY                       (default: current year, company timezone)
 *   &quarters=Q1,Q2 | &months=Jan,Feb (optional, not both; default whole year)
 *   &policyIds=a,b &departmentId=x &userIds=a,b &includeInactive=true
 * Errors are JSON; success streams an .xlsx.
 */
const getLeaveTemplateReport = async (req, res) => {
  try {
    const report = await buildLeaveTemplateReport(req.user, req.query);
    const buffer = await generateLeaveReportXlsx(report);

    // BB-119: BizBuddy_LeaveReport_{Company}_{Year}[_months]_{date-time}.xlsx, like the other reports.
    const range = report.groupBy === "year" ? "" : `_${report.periods.join("-")}`;
    const companyPart = (report.company.name || "Company").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    const stamp = moment(report.generatedAt).tz(report.company.timezone).format("YYYY-MM-DD_HH-mm");
    const filename = `BizBuddy_LeaveReport_${companyPart}_${report.year}${range}_${stamp}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getLeaveTemplateReport error:", err);
    return res.status(500).json({ message: "Failed to build leave report." });
  }
};

module.exports = { getLeaveReport, getLeaveTemplateReport };
