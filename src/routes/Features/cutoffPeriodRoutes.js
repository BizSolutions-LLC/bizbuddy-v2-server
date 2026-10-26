// src/routes/Features/cutoffPeriodRoutes.js
// ✅ CONSOLIDATED — Single source of truth for all cutoff period operations
// ⚠️  DEPRECATED: cutoffApprovalsController.js is no longer used
//     The /api/cutoff/ approval routes have been removed from cutoffRoutes.js
//     All approval operations now live here under /api/cutoff-periods/

const express = require("express");
const router = express.Router();
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const authenticate = require("@middlewares/authMiddleware");

const {
  createCutoffPeriod,
  getCutoffPeriods,
  getCutoffPeriodById,
  updateCutoffStatus,
  finalizeCutoffPeriod,
  deleteCutoffPeriod,
  getCutoffApprovals,
  getPendingApprovals,
  syncCutoffApprovals,
  bulkUpdateApprovals,
  updateSingleApproval,
  resolveConflict,
  getCutoffSummary,
  approveOtBlock,
  resetApproval,
  setPunchType,
  updateFixedHoursRecord,
} = require("@controllers/Features/cutoffPeriodController");

// ============================================================================
// CUTOFF PERIOD CRUD
// ============================================================================

/**
 * @route   POST /api/cutoff-periods/create
 * @desc    Create a manual cutoff period
 * @access  Admin, Superadmin
 * NOTE: Must be defined BEFORE /:id to prevent "create" being matched as an id
 */
router.post(
  "/create",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  createCutoffPeriod
);

/**
 * @route   GET /api/cutoff-periods
 * @desc    Get all cutoff periods (with optional ?departmentId & ?status filters)
 * @access  Admin, Supervisor, Superadmin
 */
router.get(
  "/",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getCutoffPeriods
);

// ============================================================================
// APPROVAL ROUTES
// ⚠️  ORDERING IS CRITICAL — specific paths must come before dynamic /:id paths
//     Express matches top-to-bottom. If /:id is defined first, "pending" and
//     "bulk" would be treated as approvalIds and hit the wrong handler.
// ============================================================================

/**
 * @route   POST /api/cutoff-periods/:id/sync
 * @desc    Sync approval records — creates any missing TimeLogApproval rows
 *          for time logs that fall within the cutoff period.
 *          Safe to call multiple times. Only works on open cutoffs.
 * @access  Admin, Superadmin
 */
router.post(
  "/:id/sync",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  syncCutoffApprovals
);

/**
 * @route   GET /api/cutoff-periods/:id/approvals/pending
 * @desc    Get pending approvals for a cutoff period (with schedule + break calculations)
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be before /:id/approvals/:approvalId
 */
router.get(
  "/:id/approvals/pending",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getPendingApprovals
);

/**
 * @route   PATCH /api/cutoff-periods/:id/approvals/bulk
 * @desc    Bulk approve or exclude multiple time logs
 * @body    { timeLogIds: string[], action: 'approve' | 'exclude', notes?: string }
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be before /:id/approvals/:approvalId
 */
router.patch(
  "/:id/approvals/bulk",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  bulkUpdateApprovals
);

/**
 * @route   PATCH /api/cutoff-periods/:id/ot-blocks/:otBlockId
 * @desc    Approve or exclude a computed OT block (B&C only)
 * @body    { action: 'approve' | 'exclude', notes?: string }
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be before /:id/approvals/:approvalId to avoid route collision
 */
router.patch(
  "/:id/ot-blocks/:otBlockId",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  approveOtBlock
);

/**
 * @route   PATCH /api/cutoff-periods/:id/fixed-hours/:fixedHoursId
 * @desc    BB-089 — override a fixed-hours employee's flat hours for this cutoff
 * @body    { hours: number, notes?: string }
 * @access  Admin, Supervisor, Superadmin
 */
router.patch(
  "/:id/fixed-hours/:fixedHoursId",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  updateFixedHoursRecord
);

/**
 * @route   PATCH /api/cutoff-periods/:id/approvals/:approvalId/set-punch-type
 * @desc    DayCare only — change a pending punch type between REGULAR and TRAINING
 * @body    { punchType: "TRAINING" | "REGULAR" }
 * @access  Admin, Supervisor, Superadmin
 */
router.patch(
  "/:id/approvals/:approvalId/set-punch-type",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  setPunchType
);

/**
 * @route   PATCH /api/cutoff-periods/:id/approvals/:approvalId/reset
 * @desc    Reset a single approved punch back to pending — clears actualHours,
 *          approvedClockIn/Out, and approval metadata. Raw timeIn/timeOut untouched.
 *          OT block for the day is recomputed automatically.
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be before /:id/approvals/:approvalId
 */
router.patch(
  "/:id/approvals/:approvalId/reset",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  resetApproval
);

/**
 * @route   PATCH /api/cutoff-periods/:id/approvals/:approvalId/conflict
 * @desc    Resolve a punch vs leave conflict for a single approval
 * @body    { choice: 'punch' | 'leave' }
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be before /:id/approvals/:approvalId
 */
router.patch(
  "/:id/approvals/:approvalId/conflict",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  resolveConflict
);

/**
 * @route   PATCH /api/cutoff-periods/:id/approvals/:approvalId
 * @desc    Approve, exclude, or reject a single time log
 * @body    { action: 'approve' | 'exclude' | 'reject', notes?: string, reason?: string, withOT?: boolean }
 * @access  Admin, Supervisor, Superadmin
 */
router.patch(
  "/:id/approvals/:approvalId",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  updateSingleApproval
);

/**
 * @route   GET /api/cutoff-periods/:id/approvals
 * @desc    Get all approvals for a cutoff period (filterable by ?status=)
 * @access  Admin, Supervisor, Superadmin
 */
router.get(
  "/:id/approvals",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getCutoffApprovals
);

// ============================================================================
// SINGLE PERIOD ROUTES
// These all start with /:id — ordering here matters less but kept logical
// ============================================================================

/**
 * @route   GET /api/cutoff-periods/:id/summary
 * @desc    Get payroll summary for a cutoff period
 * @access  Admin, Supervisor, Superadmin
 */
router.get(
  "/:id/summary",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getCutoffSummary
);

/**
 * @route   PATCH /api/cutoff-periods/:id/status
 * @desc    Update cutoff status: open → locked → processed
 * @body    { status: 'open' | 'locked' | 'processed' }
 * @access  Admin, Superadmin
 */
router.patch(
  "/:id/status",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  updateCutoffStatus
);

/**
 * @route   POST /api/cutoff-periods/:id/finalize
 * @desc    Finalize and lock a cutoff period — non-reversible
 *          Validates all records are approved or excluded before locking.
 *          Treats legacy 'rejected' records as excluded for backward compat.
 * @access  Admin, Superadmin
 */
router.post(
  "/:id/finalize",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  finalizeCutoffPeriod
);

/**
 * @route   DELETE /api/cutoff-periods/:id
 * @desc    Delete a cutoff period (only if not processed)
 * @access  Admin, Superadmin
 */
router.delete(
  "/:id",
  authenticate,
  authorizeRoles("admin", "superadmin"),
  deleteCutoffPeriod
);

/**
 * @route   GET /api/cutoff-periods/:id
 * @desc    Get a single cutoff period with full approval details
 * @access  Admin, Supervisor, Superadmin
 * NOTE: Must be LAST among /:id routes — acts as catch-all for GET /:id
 */
router.get(
  "/:id",
  authenticate,
  authorizeRoles("admin", "supervisor", "superadmin"),
  getCutoffPeriodById
);

module.exports = router;