// src/controllers/Reports/leaveRequestsReportController.js
//
// BB-119: GET /api/reports/leave/requests?format=pdf|xlsx|csv&from=&to=&status=
// The Leave Requests report, built on the server (replaces the client's
// lib/exports/leaveRequests.js). Errors are JSON { message }; success sends the file.

const {
  buildLeaveRequestsReport,
  leaveRequestsCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
} = require("@services/Reports/leaveRequestsReportService");
const { generateLeaveRequestsReportPDF } = require("@utils/generateLeaveRequestsReportPDF");
const { generateLeaveRequestsReportXlsx } = require("@utils/generateLeaveRequestsReportXlsx");
const { toCsv } = require("@utils/csv");

const FORMATS = ["pdf", "xlsx", "csv"];
const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

const getLeaveRequestsReport = async (req, res) => {
  try {
    const format = String(req.query.format || "pdf").toLowerCase();
    if (!FORMATS.includes(format)) return res.status(400).json({ message: "format must be pdf, xlsx or csv." });

    const report = await buildLeaveRequestsReport(req.user, req.query);
    const buffer =
      format === "pdf"
        ? await generateLeaveRequestsReportPDF(report)
        : format === "xlsx"
          ? await generateLeaveRequestsReportXlsx(report)
          : toCsv(csvHeaders(report), leaveRequestsCsvRows(report));

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report, format)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getLeaveRequestsReport error:", err);
    return res.status(500).json({ message: "Failed to build the leave requests report." });
  }
};

module.exports = { getLeaveRequestsReport };
