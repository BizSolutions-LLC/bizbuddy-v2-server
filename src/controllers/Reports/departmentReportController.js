// src/controllers/Reports/departmentReportController.js
//
// BB-119: GET /api/reports/departments?format=pdf|xlsx|csv — the Departments report,
// built on the server (replaces the client's lib/exports/departments.js).
// Admin/superadmin: every department. Supervisor: their own department.
// Errors are JSON { message }; success sends the file.

const {
  buildDepartmentReport,
  departmentsCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
} = require("@services/Reports/departmentReportService");
const { generateDepartmentsReportPDF } = require("@utils/generateDepartmentsReportPDF");
const { generateDepartmentsReportXlsx } = require("@utils/generateDepartmentsReportXlsx");
const { toCsv } = require("@utils/csv");

const FORMATS = ["pdf", "xlsx", "csv"];
const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

const getDepartmentsReport = async (req, res) => {
  try {
    const format = String(req.query.format || "pdf").toLowerCase();
    if (!FORMATS.includes(format)) return res.status(400).json({ message: "format must be pdf, xlsx or csv." });

    const report = await buildDepartmentReport(req.user);
    const buffer =
      format === "pdf"
        ? await generateDepartmentsReportPDF(report)
        : format === "xlsx"
          ? await generateDepartmentsReportXlsx(report)
          : toCsv(csvHeaders(report), departmentsCsvRows(report));

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report, format)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getDepartmentsReport error:", err);
    return res.status(500).json({ message: "Failed to build the departments report." });
  }
};

module.exports = { getDepartmentsReport };
