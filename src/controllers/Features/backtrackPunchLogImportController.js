// src/controllers/Features/backtrackPunchLogImportController.js
// BB-086 — historical "backtrack" punch-log import from the legacy PadPro
// payroll-summary CSV format. Two-phase: preview (no writes) then confirm.

const { previewBacktrackImport, commitBacktrackImport } = require("@services/Features/backtrackImportService");
const { CsvShapeError } = require("@utils/csvBacktrackPunchLogParser");

/**
 * POST /api/backtrack-punch-log-import/preview
 * multipart/form-data, file field name: "file", optional body field
 * "cutoffPeriodId". When omitted, the server auto-detects an existing open
 * cutoff period covering the file's dates, or — if none exists — still
 * returns the full preview along with `needsCutoffPeriod: true` and a
 * suggested date range so the client can prompt to create one before
 * confirming. Parses, matches employees, synthesizes times, and predicts
 * post-approval credited hours per segment. Writes nothing either way.
 */
const previewBacktrack = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded. Expected a multipart field named 'file'." });
    }

    const preview = await previewBacktrackImport({
      buffer: req.file.buffer,
      companyId: req.user.companyId,
      cutoffPeriodId: req.body.cutoffPeriodId,
      actingRole: (req.user.role || "").toLowerCase(),
      actingDepartmentId: req.user.departmentId,
    });

    return res.status(200).json({ message: "Preview generated.", data: preview });
  } catch (error) {
    if (error instanceof CsvShapeError || error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error previewing backtrack import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * POST /api/backtrack-punch-log-import/confirm
 * JSON body: { cutoffPeriodId, entries }. `entries` is the (possibly
 * admin-edited) preview payload — rows may carry `skip: true` or a manual
 * `userId` override. Re-validates against current DB state and commits.
 */
const confirmBacktrack = async (req, res) => {
  try {
    const { cutoffPeriodId, entries } = req.body;
    if (!cutoffPeriodId) {
      return res.status(400).json({ message: "cutoffPeriodId is required." });
    }

    const { created, failed, conflicted, approvalsSynced } = await commitBacktrackImport({
      companyId: req.user.companyId,
      actingUserId: req.user.id,
      actingRole: (req.user.role || "").toLowerCase(),
      actingDepartmentId: req.user.departmentId,
      cutoffPeriodId,
      entries,
    });

    return res.status(207).json({
      message: `Import complete. ${created.length} imported, ${conflicted.length} deferred (conflict), ${failed.length} failed. ${approvalsSynced} approval record(s) synced.`,
      data: { created, failed, conflicted, approvalsSynced },
    });
  } catch (error) {
    if (error.isRowCapError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("❌ Error confirming backtrack import:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { previewBacktrack, confirmBacktrack };
