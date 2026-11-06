// src/controllers/Features/punchLogImportController.js
// BB-077 — CSV bulk import of historical punch logs.

const {
  buildPunchLogTemplate,
  importPunchLogsFromCsv,
  ImportError,
} = require("@services/Features/punchLogImportService");
const { buildTemplateCsv, CsvShapeError } = require("@utils/csvPunchLogParser");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");

/**
 * GET /api/punch-log-import/template
 *   ?startDate=YYYY-MM-DD &endDate=YYYY-MM-DD (≤ 31 days)
 *   &userIds=a,b | &departmentId=x   (neither = everyone in scope)
 * BB-108: pre-filled CSV, one row per active employee × date; the admin only fills
 * clockIn/clockOut. Without startDate/endDate it returns the original blank template.
 * Both start with a guide row ("# GUIDE - not imported"), which uploads skip.
 */
const downloadPunchLogTemplate = async (req, res) => {
  try {
    if (!req.query.startDate && !req.query.endDate) {
      const csv = buildTemplateCsv({ isBnc: BNC_COMPANY_IDS.has(req.user.companyId) });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="punch_log_import_template.csv"');
      return res.send(csv);
    }

    const { csv, filename } = await buildPunchLogTemplate({
      companyId: req.user.companyId,
      actingUserId: req.user.id,
      actingRole: (req.user.role || "").toLowerCase(),
      query: req.query,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error) {
    if (error instanceof ImportError) {
      console.warn(
        `[BB-108] Punch log template refused (${error.status}): ${error.message}` +
          ` | user=${req.user.id} role=${req.user.role} dept=${req.user.departmentId || "none"}` +
          ` | query=${JSON.stringify(req.query)}` +
          (error.debug ? ` | ${JSON.stringify(error.debug)}` : "")
      );
      return res.status(error.status).json({ message: error.message });
    }
    console.error("❌ Error building punch log template:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
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

    const { created, failed, skipped } = await importPunchLogsFromCsv({
      buffer: req.file.buffer,
      companyId: req.user.companyId,
      approverId: req.user.id,
      approverRole: (req.user.role || "").toLowerCase(),
      approverDepartmentId: req.user.departmentId,
    });

    return res.status(207).json({
      message: `Import complete. ${created.length} imported, ${failed.length} failed, ${skipped} blank rows skipped.`,
      data: { created, failed, skipped },
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
