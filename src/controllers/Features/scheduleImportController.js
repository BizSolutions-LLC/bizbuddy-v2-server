// src/controllers/Features/scheduleImportController.js
// BB-081 — CSV bulk import of employee schedules (block-grid template, preview/confirm).

const { previewScheduleImport, commitScheduleImport } = require("@services/Features/scheduleImportService");
const { buildTemplateCsv, CsvShapeError } = require("@utils/csvScheduleParser");

/**
 * GET /api/schedule-import/template?weekStart=YYYY-MM-DD&overnight=true|false
 * Downloads a blank CSV template (7 date rows + one filled example row) with the exact
 * column names the preview endpoint expects.
 */
const downloadScheduleTemplate = async (req, res) => {
  const { weekStart, overnight } = req.query;
  const csv = buildTemplateCsv({ weekStart, overnight: overnight === "true" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="schedule_import_template.csv"');
  return res.send(csv);
};

/**
 * POST /api/schedule-import/preview
 * multipart/form-data, file field name: "file"; body also carries `overnight` ("true"/"false").
 * Parses and validates the file, merging each row's marked time blocks into a proposed
 * shift and checking conflicts against existing shifts — writes nothing to the database.
 */
const previewScheduleUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded. Expected a multipart field named 'file'." });
    }

    const rows = await previewScheduleImport({
      buffer: req.file.buffer,
      companyId: req.user.companyId,
      actingUserId: req.user.id,
      actingRole: (req.user.role || "").toLowerCase(),
      actingDepartmentId: req.user.departmentId,
      overnight: req.body.overnight === "true",
    });

    const readyCount = rows.filter((r) => r.status === "ready").length;
    return res.status(200).json({
      message: `Preview complete. ${readyCount} of ${rows.length} rows are ready to import.`,
      data: { rows },
    });
  } catch (error) {
    if (error instanceof CsvShapeError || error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error previewing schedule import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * POST /api/schedule-import/confirm
 * JSON body: { rows: [...] } — the (possibly user-edited) rows returned by /preview.
 * Actually creates the Shift/UserShift records; re-validates scope and conflicts
 * against current data first, since the preview may be stale by confirm time.
 */
const confirmScheduleImport = async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "No rows to import." });
    }

    const { created, skipped, failed } = await commitScheduleImport({
      companyId: req.user.companyId,
      actingUserId: req.user.id,
      actingRole: (req.user.role || "").toLowerCase(),
      actingDepartmentId: req.user.departmentId,
      rows,
    });

    return res.status(207).json({
      message: `Import complete. ${created.length} shifts created, ${skipped.length} skipped, ${failed.length} failed.`,
      data: { created, skipped, failed },
    });
  } catch (error) {
    if (error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error confirming schedule import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { downloadScheduleTemplate, previewScheduleUpload, confirmScheduleImport };
