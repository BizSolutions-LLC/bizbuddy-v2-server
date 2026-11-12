// src/controllers/Reports/employeeReportController.js
//
// BB-119: GET /api/reports/employees?format=pdf|xlsx|csv — the Employees report,
// built on the server (replaces the client's lib/exports/employees.js).
// Admin/superadmin: whole company. Supervisor: their department + direct reports.
// Errors are JSON { message }; success sends the file.

const {
  buildEmployeeReport,
  employeesCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
} = require("@services/Reports/employeeReportService");
const { generateEmployeesReportPDF } = require("@utils/generateEmployeesReportPDF");
const { generateEmployeesReportXlsx } = require("@utils/generateEmployeesReportXlsx");
const { toCsv } = require("@utils/csv");

const FORMATS = ["pdf", "xlsx", "csv"];
const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

const getEmployeesReport = async (req, res) => {
  try {
    const format = String(req.query.format || "pdf").toLowerCase();
    if (!FORMATS.includes(format)) return res.status(400).json({ message: "format must be pdf, xlsx or csv." });

    const report = await buildEmployeeReport(req.user);
    const buffer =
      format === "pdf"
        ? await generateEmployeesReportPDF(report)
        : format === "xlsx"
          ? await generateEmployeesReportXlsx(report)
          : toCsv(csvHeaders(report), employeesCsvRows(report));

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report, format)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getEmployeesReport error:", err);
    return res.status(500).json({ message: "Failed to build the employees report." });
  }
};

module.exports = { getEmployeesReport };
