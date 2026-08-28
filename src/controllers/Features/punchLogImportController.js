// src/controllers/Features/punchLogImportController.js
// BB-077 — CSV bulk import of historical punch logs.

const { importPunchLogsFromCsv } = require("@services/Features/punchLogImportService");
const { buildTemplateCsv, CsvShapeError } = require("@utils/csvPunchLogParser");

/**
 * GET /api/punch-log-import/template
 * Downloads a blank CSV template (header row + one example row) with the exact
 * column names the upload endpoint expects.
 */
const downloadPunchLogTemplate = async (req, res) => {
  const csv = buildTemplateCsv();
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="punch_log_import_template.csv"');
  return res.send(csv);
};

/**
 * POST /api/punch-log-import/upload
 * multipart/form-data, file field name: "file".
 * Imports every valid row as an approved punch log; invalid/conflicting/locked-period
 * rows are skipped and reported back individually — partial success, not all-or-nothing.
 */
const bulkImportPunchLogs = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded. Expected a multipart field named 'file'." });
    }

    const { created, failed } = await importPunchLogsFromCsv({
      buffer: req.file.buffer,
      companyId: req.user.companyId,
      approverId: req.user.id,
      approverRole: (req.user.role || "").toLowerCase(),
      approverDepartmentId: req.user.departmentId,
    });

    return res.status(207).json({
      message: `Import complete. ${created.length} imported, ${failed.length} failed.`,
      data: { created, failed },
    });
  } catch (error) {
    if (error instanceof CsvShapeError || error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error importing punch logs:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { downloadPunchLogTemplate, bulkImportPunchLogs };
