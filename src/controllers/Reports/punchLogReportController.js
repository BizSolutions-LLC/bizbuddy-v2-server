// src/controllers/Reports/punchLogReportController.js
//
// BB-119 steps 8 + 9: GET /api/reports/punch-logs — the shared Punch Logs report
// (docs/changelog-v2.11.7.md). format=pdf (phase 1b, default),
// format=xlsx (the company page's detail export, replaces its browser "CSV Detail")
// format=csv (Details CSV, phase 1a), format=payroll (the Payroll Grid as Excel)
// and format=payroll-csv (the same grid as the original CSV layout) — phase 1c,
// services/Reports/punchLogPayrollGrid.js; team scope only.
// Read-only. Errors are JSON { message }; success sends the file.

const {
  buildPunchLogReport,
  punchLogsCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
} = require("@services/Reports/punchLogReportService");
const { generatePunchLogsReportPDF } = require("@utils/generatePunchLogsReportPDF");
const { generatePunchLogsReportXlsx } = require("@utils/generatePunchLogsReportXlsx");
const { buildPayrollGrid } = require("@services/Reports/punchLogPayrollGrid");
const { generatePayrollGridXlsx } = require("@utils/generatePayrollGridXlsx");
const { toCsv } = require("@utils/csv");

const READY = ["pdf", "xlsx", "csv", "payroll", "payroll-csv"];
const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  payroll: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "payroll-csv": "text/csv; charset=utf-8",
};

const getPunchLogReport = async (req, res) => {
  try {
    const format = String(req.query.format || "pdf").toLowerCase();
    if (!READY.includes(format)) return res.status(400).json({ message: "format must be pdf, xlsx, csv, payroll or payroll-csv." });

    if (format === "payroll" || format === "payroll-csv") {
      const grid = await buildPayrollGrid(req.user, req.query);
      const xlsx = format === "payroll";
      const file = xlsx ? await generatePayrollGridXlsx(grid) : toCsv(grid.headers, grid.rows);
      res.setHeader("Content-Type", CONTENT_TYPE[format]);
      res.setHeader("Content-Disposition", `attachment; filename="${grid.fileName(xlsx ? "xlsx" : "csv")}"`);
      res.setHeader("Content-Length", file.length);
      return res.status(200).send(file);
    }

    const report = await buildPunchLogReport(req.user, req.query);
    const buffer =
      format === "pdf"
        ? await generatePunchLogsReportPDF(report)
        : format === "xlsx"
          ? await generatePunchLogsReportXlsx(report)
          : toCsv(csvHeaders(report), punchLogsCsvRows(report));

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report, format)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getPunchLogReport error:", err);
    return res.status(500).json({ message: "Failed to build the punch logs report." });
  }
};

module.exports = { getPunchLogReport };
