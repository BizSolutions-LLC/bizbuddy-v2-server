// src/controllers/Reports/contestReportController.js
//
// BB-119: GET /api/reports/contests?format=pdf|xlsx|csv&scope=mine|team&from=&to=&status=
// The Contest Time Logs report, built on the server (replaces the client's
// lib/exports/contestLogs.js). Errors are JSON { message }; success sends the file.

const {
  buildContestReport,
  contestsCsvRows,
  csvHeaders,
  reportFileName,
  ReportError,
} = require("@services/Reports/contestReportService");
const { generateContestReportPDF } = require("@utils/generateContestReportPDF");
const { generateContestReportXlsx } = require("@utils/generateContestReportXlsx");
const { toCsv } = require("@utils/csv");

const FORMATS = ["pdf", "xlsx", "csv"];
const CONTENT_TYPE = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

const getContestReport = async (req, res) => {
  try {
    const format = String(req.query.format || "pdf").toLowerCase();
    if (!FORMATS.includes(format)) return res.status(400).json({ message: "format must be pdf, xlsx or csv." });

    const report = await buildContestReport(req.user, req.query);
    const buffer =
      format === "pdf"
        ? await generateContestReportPDF(report)
        : format === "xlsx"
          ? await generateContestReportXlsx(report)
          : toCsv(csvHeaders(report), contestsCsvRows(report));

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${reportFileName(report, format)}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ReportError) return res.status(err.status).json({ message: err.message });
    console.error("getContestReport error:", err);
    return res.status(500).json({ message: "Failed to build the contest report." });
  }
};

module.exports = { getContestReport };
