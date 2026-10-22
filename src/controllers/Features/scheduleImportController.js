// src/controllers/Features/scheduleImportController.js
// BB-081 — CSV bulk import of employee schedules; reworked in BB-103 ("Upload
// Schedule": date range up to 14 days, pre-filled template, time-block or
// existing-shift marking, Replace on conflicts). See scheduleImportService.

const {
  buildScheduleTemplate,
  previewSchedule,
  confirmSchedule,
  previewScheduleImport,
  commitScheduleImport,
  ScheduleImportError,
} = require("@services/Features/scheduleImportService");
const { CsvShapeError } = require("@utils/csvScheduleParser");

const actorOf = (req) => ({
  companyId: req.user.companyId,
  actingUserId: req.user.id,
  actingRole: (req.user.role || "").toLowerCase(),
});

/**
 * GET /api/schedule-import/template
 *   ?mode=time_blocks|shifts &startDate=YYYY-MM-DD &endDate=YYYY-MM-DD (≤ 14 days)
 *   &userIds=a,b | &departmentId=x   (neither = everyone in scope)
 *   &shiftIds=a,b                    (shifts mode, column order)
 * Pre-filled CSV: one row per active employee × date. The pre-BB-103
 * ?weekStart=YYYY-MM-DD still works (time_blocks, 7 days).
 */
const downloadScheduleTemplate = async (req, res) => {
  try {
    const { csv, filename } = await buildScheduleTemplate({ ...actorOf(req), query: req.query });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error) {
    if (error instanceof ScheduleImportError) return res.status(error.status).json({ message: error.message });
    console.error("❌ Error building schedule template:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * POST /api/schedule-import/preview
 * multipart/form-data: file, mode, overnight (time_blocks), shiftIds (shifts),
 * optional startDate/endDate. Writes nothing. Without `mode` it runs the pre-BB-103
 * preview (`data.rows`) for the old client.
 */
const previewScheduleUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded. Expected a multipart field named 'file'." });
    }

    if (!req.body.mode) {
      const rows = await previewScheduleImport({
        ...actorOf(req),
        buffer: req.file.buffer,
        overnight: req.body.overnight === "true",
      });
      const readyCount = rows.filter((r) => r.status === "ready").length;
      return res.status(200).json({
        message: `Preview complete. ${readyCount} of ${rows.length} rows are ready to import.`,
        data: { rows },
      });
    }

    const data = await previewSchedule({ ...actorOf(req), buffer: req.file.buffer, body: req.body });
    return res.status(200).json({
      message: `Preview complete. ${data.summary.ready} ready, ${data.summary.conflictExisting + data.summary.conflictFile} in conflict, ${data.summary.error} with errors.`,
      data,
    });
  } catch (error) {
    if (error instanceof ScheduleImportError) return res.status(error.status).json({ message: error.message });
    if (error instanceof CsvShapeError || error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error previewing schedule import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * POST /api/schedule-import/confirm
 * JSON: { mode, decisions: [{ key, action: create|replace|skip }], items: [...] }.
 * Re-validates against current data, then writes. 200 when nothing failed, 207
 * otherwise. A body with `rows` (no `mode`) runs the pre-BB-103 confirm.
 */
const confirmScheduleImport = async (req, res) => {
  try {
    if (!req.body.mode) {
      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No rows to import." });
      }
      const { created, skipped, failed } = await commitScheduleImport({ ...actorOf(req), rows });
      return res.status(207).json({
        message: `Import complete. ${created.length} shifts created, ${skipped.length} skipped, ${failed.length} failed.`,
        data: { created, skipped, failed },
      });
    }

    const data = await confirmSchedule({ ...actorOf(req), body: req.body });
    return res.status(data.failed.length ? 207 : 200).json({
      message: `Import complete. ${data.created.length} created, ${data.replaced.length} replaced, ${data.skipped.length} skipped, ${data.failed.length} failed.`,
      data,
    });
  } catch (error) {
    if (error instanceof ScheduleImportError) return res.status(error.status).json({ message: error.message });
    if (error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error confirming schedule import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { downloadScheduleTemplate, previewScheduleUpload, confirmScheduleImport };
