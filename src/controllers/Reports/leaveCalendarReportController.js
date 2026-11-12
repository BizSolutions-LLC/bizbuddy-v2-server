// src/controllers/Reports/leaveCalendarReportController.js
//
// BB-119: GET /api/reports/leave/calendar?month=YYYY-MM&status=… — the Leave
// Calendar PDF, built on the server (replaces the client's lib/exports/leaveCalendar.js).
// Errors are JSON { message }; success sends the PDF.

const { buildLeaveCalendarReport, reportFileName, ReportError } = require("@services/Reports/leaveCalendarReportService");
const { generateLeaveCalendarReportPDF } = require("@utils/generateLeaveCalendarReportPDF");

const getLeaveCalendarReport = async (req, res) => {
  try {
    const report = await buildLeaveCalendarReport(req.user, req.query);
    const buffer = await generateLeaveCalendarReportPDF(report);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getLeaveCalendarReport error:", err);
    return res.status(500).json({ message: "Failed to build the leave calendar." });
  }
};

module.exports = { getLeaveCalendarReport };
