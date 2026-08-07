// src/controllers/Features/cutoffPeriodController.js
// ✅ CONSOLIDATED & FIXED
//
// Changes from previous version:
//  1. createCutoffPeriod   — now saves companyId + departmentId
//  2. getCutoffPeriodById  — uses companyId directly (consistent with getCutoffPeriods)
//  3. updateCutoffStatus   — uses companyId directly; pending check excludes 'excluded' & 'rejected'
//  4. updateSingleApproval — handles 'approve', 'exclude', AND legacy 'reject' actions
//  5. bulkUpdateApprovals  — handles 'approve' and 'exclude'; legacy 'reject' kept for safety
//  6. finalizeCutoffPeriod — NEW: validates all records done, locks period, non-reversible
//  7. resolveConflict      — NEW: handles punch vs leave conflict resolution
//  8. ID generation        — uses crypto.randomUUID() to prevent collision
//
// Backward compat:
//  - 'rejected' status treated same as 'excluded' in all business logic checks
//  - Old records without companyId fall back to creator.companyId lookup

const { prisma } = require("@config/connection");
const moment = require("moment-timezone");
const { randomUUID } = require("crypto");
const { createNotification } = require("@services/notificationService");
const { resolveDriverAideSegments, computeTimeLogSummary } = require("@services/timeLogComputeService");
const { applyAutoBreaks } = require("@services/autoBreakService");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const daycareCutoffStrategy                        = require("@services/Cutoff/daycareCutoffStrategy");
const { syncApprovedSegmentsToTimeLog, syncApprovedRegularToTimeLog } = daycareCutoffStrategy;
const bncCutoffStrategy                            = require("@services/Cutoff/bncCutoffStrategy");
const { recomputeAllOtForCutoff, recomputeOtForTimeLog } = require("@services/Cutoff/cutoffOtService");
const { combineDateTime } = require("@services/Cutoff/shiftLookupUtils");
const { calcDailyHours } = require("@utils/leaveUtils");
const { DRIVER_SEGMENT_MAP, isDriverSegmentPunchType } = require("@utils/punchTypeUtils");
const { generatePayrollExportForCutoffPeriod } = require("@services/Payroll/payrollExportService");

function getApprovalStrategy(companyId) {
  return BNC_COMPANY_IDS.has(companyId) ? bncCutoffStrategy : daycareCutoffStrategy;
}

// Break computation is handled by timeLogComputeService — enrichApprovals reads
// stored lunchDeductionMinutes and totalBreakMinutes directly from the TimeLog.

/**
 * Shared: resolve companyId for a cutoff period
 * Supports both old records (companyId via creator) and new records (companyId direct)
 */
async function findCutoffForCompany(id, companyId) {
  return prisma.cutoffPeriod.findFirst({
    where: {
      id,
      OR: [
        { companyId },
        { creator: { companyId } },
      ],
    },
  });
}

/**
 * Shared: enrich approval records using stored computed fields from timeLogComputeService.
 * Reads lateHours, undertimeHours, netWorkedHours, segment hours etc. directly from the
 * TimeLog — no independent recomputation. For DRIVER_AIDE punches, maps each segmentType
 * to its stored segment field.
 */
function enrichApprovals(approvals, gracePeriodMinutes) {
  return approvals.map((approval) => {
    const tl = approval.timeLog;
    if (!tl) return approval;

    const isDriverAide   = tl.punchType === "DRIVER_AIDE";
    const segmentType    = approval.segmentType ?? null;

    const lateHours      = parseFloat(tl.lateHours      ?? 0);
    const undertimeHours = parseFloat(tl.undertimeHours ?? 0);
    const grossHours     = parseFloat(tl.grossHours     ?? 0);
    const rawOtMinutes   = tl.rawOtMinutes ?? 0;

    const approvedOTHours = (tl.overtime || []).reduce(
      (sum, ot) => sum + parseFloat(ot.requestedHours || 0), 0
    );

    let segmentHours      = null;
    let segLateHours      = 0;
    let segUndertimeHours = 0;
    let segScheduledHours = null;
    let segRawOtMinutes   = 0;

    if (isDriverAide) {
      // segScheduledHours = the full segment window duration (segmentEnd − segmentStart).
      // segmentHours      = for approved records: prefer the stored actualHours — it's
      //                     written by the approval strategy and is grace-period aware for
      //                     Raw mode (approvedClockIn intentionally stays the raw punch, so
      //                     it can under-report credited hours if used directly). Falls back
      //                     to deriving from approvedClockIn/Out for legacy records written
      //                     before actualHours was reliably populated for DRIVER_AIDE segments.
      //                     Guard: skip the derived fallback if approvedClockIn is before
      //                     segmentStart — that indicates a historical record written before
      //                     the Raw clip fix, where the global clock-in was stored instead of
      //                     segmentStart. Pending records fall back to the stored TimeLog
      //                     segment value.
      const windowHours = approval.segmentStart && approval.segmentEnd
        ? parseFloat(((new Date(approval.segmentEnd) - new Date(approval.segmentStart)) / 3600000).toFixed(2))
        : null;

      const approvedHours = (() => {
        if (approval.status !== "approved") return null;
        if (approval.actualHours != null) return parseFloat(approval.actualHours.toString());
        if (!approval.approvedClockIn || !approval.approvedClockOut) return null;
        const inMs     = new Date(approval.approvedClockIn).getTime();
        const segStart = approval.segmentStart ? new Date(approval.segmentStart).getTime() : -Infinity;
        if (inMs < segStart) return null; // stale bad record — fall back to stored
        return parseFloat(((new Date(approval.approvedClockOut) - new Date(approval.approvedClockIn)) / 3600000).toFixed(2));
      })();

      if (segmentType === "driver_am") {
        const stored  = tl.driverAmSegmentHours != null ? parseFloat(tl.driverAmSegmentHours.toString()) : null;
        segmentHours      = approvedHours ?? stored ?? windowHours;
        segLateHours      = lateHours; // AM is the late-bearing segment (earliest shift)
        segScheduledHours = windowHours ?? stored;
      } else if (segmentType === "regular") {
        const stored  = tl.regularSegmentHours != null ? parseFloat(tl.regularSegmentHours.toString()) : null;
        segmentHours      = approvedHours ?? stored ?? windowHours;
        segScheduledHours = windowHours ?? stored;
      } else if (segmentType === "driver_pm") {
        const stored  = tl.driverPmSegmentHours != null ? parseFloat(tl.driverPmSegmentHours.toString()) : null;
        segmentHours      = approvedHours ?? stored ?? windowHours;
        segUndertimeHours = undertimeHours; // PM is the undertime-bearing segment (latest shift)
        segScheduledHours = windowHours ?? stored;
        segRawOtMinutes   = rawOtMinutes;
      }
    } else {
      // For approved records, prefer approval.actualHours — it holds the payroll-adjusted
      // value (grace-snapped for Raw, capped for Training). tl.netWorkedHours is only
      // reliable for pending records where no approval has been written yet.
      const approvedActual = (approval.status === "approved" && approval.actualHours != null)
        ? parseFloat(approval.actualHours.toString())
        : null;
      segmentHours      = approvedActual ?? (tl.netWorkedHours != null ? parseFloat(tl.netWorkedHours) : grossHours);
      segLateHours      = lateHours;
      segUndertimeHours = undertimeHours;
      segScheduledHours = tl.scheduledHours != null ? parseFloat(tl.scheduledHours) : null;
      segRawOtMinutes   = rawOtMinutes;
    }

    const lateMinutes  = parseFloat((segLateHours * 60).toFixed(2));
    const earlyMinutes = parseFloat((segUndertimeHours * 60).toFixed(2));
    const totalPayable = segmentHours != null
      ? parseFloat((segmentHours + approvedOTHours).toFixed(2))
      : null;

    const lunchMins  = tl.lunchDeductionMinutes ?? 0;
    const coffeeMins = tl.totalBreakMinutes     ?? 0;

    return {
      ...approval,
      segmentType,
      schedule: {
        scheduledHours: segScheduledHours != null ? parseFloat(segScheduledHours.toFixed(2)) : null,
      },
      calculatedData: {
        actualHours:     segmentHours != null ? parseFloat(segmentHours.toFixed(2)) : (grossHours || null),
        approvedOTHours: parseFloat(approvedOTHours.toFixed(2)),
        hasApprovedOT:   approvedOTHours > 0,
        lateMinutes,
        lateStatus: lateMinutes > 0
          ? (lateMinutes <= gracePeriodMinutes ? "within_grace" : "beyond_grace")
          : null,
        earlyMinutes,
        earlyStatus: earlyMinutes > 0 ? "left_early" : null,
        rawOtMinutes: segRawOtMinutes,
      },
      breakData: {
        lunch:  { minutes: lunchMins,  deducted: lunchMins > 0 },
        coffee: { totalMinutes: coffeeMins },
        totalDeductions: {
          minutes: lunchMins + coffeeMins,
          hours:   +((lunchMins + coffeeMins) / 60).toFixed(2),
        },
      },
      payrollSummary: {
        scheduledHours:      segScheduledHours != null ? parseFloat(segScheduledHours.toFixed(2)) : null,
        payableRegularHours: segmentHours      != null ? parseFloat(segmentHours.toFixed(2))      : null,
        approvedOTHours:     parseFloat(approvedOTHours.toFixed(2)),
        totalPayableHours:   totalPayable,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD APPROVAL INCLUDE — reused across all approval queries
// ─────────────────────────────────────────────────────────────────────────────
const APPROVAL_INCLUDE = {
  timeLog: {
    select: {
      id: true, userId: true, timeIn: true, timeOut: true,
      punchType: true, status: true, isApproved: true,
      autoClockOut: true, lunchBreak: true, coffeeBreaks: true,
      originalTimeIn: true, originalTimeOut: true,
      // Derived fields — written by timeLogComputeService (source of truth)
      lateHours: true, undertimeHours: true,
      netWorkedHours: true, grossHours: true, scheduledHours: true,
      rawOtMinutes: true, lunchDeductionMinutes: true, totalBreakMinutes: true,
      regularSegmentHours: true, driverAmSegmentHours: true, driverPmSegmentHours: true,
      isTooEarlyPunch: true,
      calculatedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          profile: true,
          companyId: true,
          departmentId: true,
          department: {
            select: {
              id: true,
              name: true,
              paidBreak: true,
              breakDuration: true,
              coffeeBreakMaxCount: true,
              coffeeBreakMinutes: true,
              coffeeBreakPaid: true,
            },
          },
        },
      },
      overtime: {
        where: { status: "approved" },
        select: { id: true, requestedHours: true, status: true },
      },
    },
  },
  approver: {
    select: {
      id: true,
      email: true,
      username: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/cutoff-periods/create
 * Create a manual cutoff period
 * ✅ FIX: Now saves companyId + departmentId
 */
const createCutoffPeriod = async (req, res) => {
  try {
    const { periodStart, periodEnd, paymentDate, frequency, departmentId } = req.body;
    const userId    = req.user.id;
    const companyId = req.user.companyId;

    if (!periodStart || !periodEnd || !paymentDate || !frequency) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const validFrequencies = ["bi-weekly", "bi-monthly", "monthly"];
    if (!validFrequencies.includes(frequency)) {
      return res.status(400).json({ message: "Invalid frequency. Must be: bi-weekly, bi-monthly, or monthly." });
    }

    const startDate = new Date(periodStart);
    const endDate   = new Date(periodEnd);
    const payDate   = new Date(paymentDate);

    if (endDate <= startDate) {
      return res.status(400).json({ message: "Period end date must be after start date." });
    }
    if (payDate < endDate) {
      return res.status(400).json({ message: "Payment date must be on or after period end date." });
    }

    // ✅ FIX: Overlap check scoped to company + department
    const overlapping = await prisma.cutoffPeriod.findFirst({
      where: {
        companyId,
        ...(departmentId ? { departmentId } : { departmentId: null }),
        OR: [
          { AND: [{ periodStart: { lte: startDate } }, { periodEnd: { gte: startDate } }] },
          { AND: [{ periodStart: { lte: endDate   } }, { periodEnd: { gte: endDate   } }] },
          { AND: [{ periodStart: { gte: startDate } }, { periodEnd: { lte: endDate   } }] },
        ],
      },
    });

    if (overlapping) {
      return res.status(400).json({ message: "Cutoff period overlaps with an existing period." });
    }

    // ✅ FIX: companyId + departmentId now persisted
    const cutoffPeriod = await prisma.cutoffPeriod.create({
      data: {
        id:          randomUUID(),
        companyId,
        departmentId: departmentId || null,
        periodStart:  startDate,
        periodEnd:    endDate,
        paymentDate:  payDate,
        frequency,
        status:       "open",
        createdBy:    userId,
        isAutoGenerated: false,
      },
    });

    // Create approval records for existing time logs in this period
    const userWhere = { companyId };
    if (departmentId) userWhere.departmentId = departmentId;

    const timeLogs = await prisma.timeLog.findMany({
      where: {
        user: userWhere,
        timeIn:  { gte: startDate, lte: endDate },
        timeOut: { not: null },
      },
      select: { id: true, punchType: true, timeIn: true, userId: true },
    });

    if (timeLogs.length > 0) {
      // Pre-resolve segment boundaries for DRIVER_AIDE logs so segmentStart / segmentEnd
      // are stored on the approval record at creation time (same as syncApprovalRecords).
      const driverAideLogs = timeLogs.filter((l) => l.punchType === "DRIVER_AIDE");
      const segBoundaries  = await resolveDriverAideSegments(driverAideLogs, companyId);

      const approvalData = timeLogs.flatMap((log) => {
        if (log.punchType === "DRIVER_AIDE") {
          const segs = segBoundaries[log.id] ?? {};
          return ["driver_am", "regular", "driver_pm"].map((segmentType) => {
            const seg = segs[segmentType] ?? null;
            return {
              id: randomUUID(), timeLogId: log.id, cutoffPeriodId: cutoffPeriod.id, status: "pending", segmentType,
              segmentStart: seg?.start ?? null,
              segmentEnd:   seg?.end   ?? null,
            };
          });
        }
        return [{ id: randomUUID(), timeLogId: log.id, cutoffPeriodId: cutoffPeriod.id, status: "pending", segmentType: null }];
      });
      await prisma.timeLogApproval.createMany({ data: approvalData, skipDuplicates: true });
    }

    console.log("[✅ Cutoff period created]", cutoffPeriod.id, `(${timeLogs.length} approvals)`);

    return res.status(201).json({
      message: "Cutoff period created successfully.",
      data: { ...cutoffPeriod, totalTimeLogs: timeLogs.length },
    });
  } catch (error) {
    console.error("❌ createCutoffPeriod:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * GET /api/cutoff-periods
 * Get all cutoff periods for the company
 */
const getCutoffPeriods = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { status, page = 1, limit = 100, departmentId } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {
      companyId,
      ...(status && { status }),
      ...(departmentId && departmentId !== "none" && { departmentId }),
      ...(departmentId === "none" && { departmentId: null }),
    };

    const [cutoffPeriods, total] = await Promise.all([
      prisma.cutoffPeriod.findMany({
        where,
        include: {
          creator: {
            select: { id: true, email: true, username: true, profile: true },
          },
          department: {
            select: { id: true, name: true },
          },
          _count: { select: { approvals: true } },
        },
        orderBy: { periodStart: "desc" },
        skip,
        take,
      }),
      prisma.cutoffPeriod.count({ where }),
    ]);

    // Approval stats per period
    // ✅ 'rejected' counted as 'excluded' for display consistency
    const periodsWithStats = await Promise.all(
      cutoffPeriods.map(async (period) => {
        const approvalStats = await prisma.timeLogApproval.groupBy({
          by: ["status"],
          where: { cutoffPeriodId: period.id },
          _count: true,
        });

        const stats = { pending: 0, approved: 0, excluded: 0 };
        approvalStats.forEach((s) => {
          if (s.status === "approved") stats.approved += s._count;
          else if (s.status === "pending") stats.pending += s._count;
          // Both 'excluded' and legacy 'rejected' roll into excluded
          else if (s.status === "excluded" || s.status === "rejected") stats.excluded += s._count;
        });

        return { ...period, approvalStats: stats };
      })
    );

    return res.status(200).json({
      message: "Cutoff periods retrieved successfully.",
      data: periodsWithStats,
      pagination: {
        page:       parseInt(page),
        limit:      parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("❌ getCutoffPeriods:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * GET /api/cutoff-periods/:id
 * Get single cutoff period with full details
 * ✅ FIX: Uses companyId directly with OR fallback for old records
 */
const getCutoffPeriodById = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    // Re-fetch with relations
    const full = await prisma.cutoffPeriod.findUnique({
      where: { id },
      include: {
        creator:    { select: { id: true, email: true, username: true, profile: true } },
        department: { select: { id: true, name: true } },
        approvals: {
          include: {
            timeLog: {
              include: {
                user: { select: { id: true, email: true, username: true, profile: true } },
              },
            },
            approver: {
              select: { id: true, email: true, username: true, profile: true },
            },
          },
          orderBy: { timeLog: { timeIn: "asc" } },
        },
      },
    });

    return res.status(200).json({
      message: "Cutoff period retrieved successfully.",
      data: full,
    });
  } catch (error) {
    console.error("❌ getCutoffPeriodById:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * PATCH /api/cutoff-periods/:id/status
 * Update cutoff status (open ↔ locked ↔ processed)
 * ✅ FIX: consistent companyId check; pending check respects excluded + legacy rejected
 */
const updateCutoffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const companyId = req.user.companyId;

    const validStatuses = ["open", "locked", "processed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be: open, locked, or processed." });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    if (cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: "Cannot change status of a processed cutoff period." });
    }

    // ✅ FIX: Only truly pending records block locking
    if (status === "locked") {
      const pendingCount = await prisma.timeLogApproval.count({
        where: {
          cutoffPeriodId: id,
          status: "pending",
        },
      });
      if (pendingCount > 0) {
        return res.status(400).json({
          message: `Cannot lock cutoff period. ${pendingCount} pending approval(s) remaining.`,
        });
      }
    }

    const updated = await prisma.cutoffPeriod.update({
      where: { id },
      data: { status },
    });

    console.log("[✅ Cutoff status updated]", id, "→", status);

    // BB-066: "processed" is the one truly final status — updateCutoffStatus
    // blocks any further change once a period is processed, unlike "locked"
    // which can still be reopened. So this recomputes this department's payroll
    // summary and folds it into the single take-latest PayrollExportBatch JSON
    // for the whole company+period on every transition to "processed" (initial
    // or re-run). Non-blocking — the status change itself must not fail just
    // because export generation did; on failure this just falls back to the
    // pre-BB-066 response wording below rather than falsely claiming the period
    // is "secured".
    let payrollExport = { generated: false };
    let departmentName = null;
    if (status === "processed") {
      try {
        const result = await generatePayrollExportForCutoffPeriod(updated);
        payrollExport = { generated: true, employeeCount: result.employeeCount };
      } catch (exportErr) {
        console.error("[⚠️ BB-066] Payroll export generation failed for", id, exportErr.message);
      }
      if (updated.departmentId) {
        const dept = await prisma.department.findUnique({ where: { id: updated.departmentId }, select: { name: true } });
        departmentName = dept?.name || null;
      }
    }

    // Send notifications based on the new status
    try {
      const startStr = cutoffPeriod.startDate ? new Date(cutoffPeriod.startDate).toLocaleDateString() : null;
      const endStr = cutoffPeriod.endDate ? new Date(cutoffPeriod.endDate).toLocaleDateString() : null;
      const periodLabel = startStr && endStr ? `${startStr} - ${endStr}` : `Cutoff #${id.slice(-6)}`;

      if (status === 'locked') {
        // Notify management
        const managementUsers = await prisma.user.findMany({
          where: { companyId, role: { in: ['admin', 'superadmin', 'supervisor'] }, status: 'active' },
          select: { id: true, departmentId: true },
        });
        await Promise.all(managementUsers.map(manager =>
          createNotification({
            userId: manager.id,
            companyId,
            departmentId: manager.departmentId,
            notificationCode: 'CUTOFF_PERIOD_LOCKED',
            title: 'Cutoff Period Locked',
            message: `Cutoff period ${periodLabel} has been locked and is ready for processing.`,
            payload: { cutoffPeriodId: id, periodLabel },
          })
        ));
      } else if (status === 'processed') {
        // Notify all active employees in the company — text intentionally NOT
        // enriched with department/employeeCount (BB-066): unlike the "locked"
        // notification (management only), this one broadcasts company-wide, so
        // payroll headcount details stay out of it. The enriched wording only
        // goes in the API response below, seen only by the admin who acted.
        const employees = await prisma.user.findMany({
          where: { companyId, status: 'active' },
          select: { id: true, departmentId: true },
        });
        await Promise.all(employees.map(emp =>
          createNotification({
            userId: emp.id,
            companyId,
            departmentId: emp.departmentId,
            notificationCode: 'CUTOFF_PROCESSED',
            title: 'Payroll Processed',
            message: `Payroll for cutoff period ${periodLabel} has been processed.`,
            payload: { cutoffPeriodId: id, periodLabel },
          })
        ));
      }
    } catch (notifError) {
      console.error('❌ Failed to send cutoff status notification:', notifError);
    }

    const responseMessage = status === "processed" && payrollExport.generated
      ? `Cutoff period status updated to processed. Payroll summary secured${departmentName ? ` for ${departmentName}` : ""} — ${payrollExport.employeeCount} employee(s).`
      : `Cutoff period status updated to ${status}.`;

    return res.status(200).json({
      message: responseMessage,
      data: status === "processed" ? { ...updated, payrollExport } : updated,
    });
  } catch (error) {
    console.error("❌ updateCutoffStatus:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * POST /api/cutoff-periods/:id/finalize
 * ✅ NEW: Finalize a cutoff period — locks it and marks it as ready for payroll
 * Non-reversible. Validates all records are approved or excluded before locking.
 * Treats legacy 'rejected' as excluded for backward compatibility.
 */
const finalizeCutoffPeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({
        message: `Cutoff period is already ${cutoffPeriod.status}.`,
      });
    }

    // ✅ Check: no pending records remain
    const pendingCount = await prisma.timeLogApproval.count({
      where: { cutoffPeriodId: id, status: "pending" },
    });

    if (pendingCount > 0) {
      return res.status(400).json({
        message: `Cannot finalize. ${pendingCount} record(s) still pending review.`,
        data: { pendingCount },
      });
    }

    // Gather final stats for the response
    const statsRaw = await prisma.timeLogApproval.groupBy({
      by: ["status"],
      where: { cutoffPeriodId: id },
      _count: true,
    });

    const stats = { approved: 0, excluded: 0 };
    statsRaw.forEach((s) => {
      if (s.status === "approved") stats.approved += s._count;
      if (s.status === "excluded" || s.status === "rejected") stats.excluded += s._count;
    });

    // ✅ Lock the period
    // NOTE: finalizedAt / finalizedBy not in schema yet — add via migration if needed
    const locked = await prisma.cutoffPeriod.update({
      where: { id },
      data: { status: "locked" },
    });

    console.log("[✅ Cutoff finalized]", id, `— ${stats.approved} approved, ${stats.excluded} excluded`);

    // Notify management that the cutoff period is locked
    try {
      const startStr = cutoffPeriod.startDate ? new Date(cutoffPeriod.startDate).toLocaleDateString() : null;
      const endStr = cutoffPeriod.endDate ? new Date(cutoffPeriod.endDate).toLocaleDateString() : null;
      const periodLabel = startStr && endStr ? `${startStr} - ${endStr}` : `Cutoff #${id.slice(-6)}`;

      const managementUsers = await prisma.user.findMany({
        where: { companyId, role: { in: ['admin', 'superadmin', 'supervisor'] }, status: 'active' },
        select: { id: true, departmentId: true },
      });
      await Promise.all(managementUsers.map(manager =>
        createNotification({
          userId: manager.id,
          companyId,
          departmentId: manager.departmentId,
          notificationCode: 'CUTOFF_PERIOD_LOCKED',
          title: 'Cutoff Period Locked',
          message: `Cutoff period ${periodLabel} has been locked and is ready for processing.`,
          payload: { cutoffPeriodId: id, periodLabel, finalStats: stats },
        })
      ));
    } catch (notifError) {
      console.error('❌ Failed to send cutoff finalize notification:', notifError);
    }

    return res.status(200).json({
      message:  "Cutoff period finalized and locked. Records are now passed to payroll.",
      data: {
        ...locked,
        finalStats: stats,
      },
    });
  } catch (error) {
    console.error("❌ finalizeCutoffPeriod:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * DELETE /api/cutoff-periods/:id
 */
const deleteCutoffPeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: "Cannot delete a processed cutoff period." });
    }

    await prisma.cutoffPeriod.delete({ where: { id } });

    console.log("[✅ Cutoff deleted]", id);
    return res.status(200).json({ message: "Cutoff period deleted successfully." });
  } catch (error) {
    console.error("❌ deleteCutoffPeriod:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC HELPER
// Creates missing TimeLogApproval records for a cutoff period.
// Safe to call multiple times — uses skipDuplicates.
// Handles both department-scoped and company-wide cutoffs.
// ─────────────────────────────────────────────────────────────────────────────
async function syncApprovalRecords(cutoffPeriod, companyId, companyTimezone = "UTC") {
  const { id: cutoffPeriodId, periodStart, periodEnd, departmentId } = cutoffPeriod;

  const userWhere = { companyId };
  if (departmentId) userWhere.departmentId = departmentId;

  // periodEnd is stored as UTC midnight of the last calendar day (e.g., 2026-05-03T00:00:00Z).
  // We interpret that UTC date string as the intended calendar date and extend it to end-of-day
  // in the company's local timezone. This correctly captures cross-midnight-UTC shifts that
  // started on the final local day (e.g., a 10 PM PDT punch has UTC timestamp 2026-05-04T05:xx).
  // Using setUTCHours would stop at 2026-05-03T23:59:59Z = 4:59 PM PDT, missing those shifts.
  const endDateStr  = new Date(periodEnd).toISOString().slice(0, 10); // "2026-05-03"
  const periodEndEOD = moment.tz(endDateStr, companyTimezone).endOf("day").toDate();

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      timeIn:  { gte: periodStart, lte: periodEndEOD },
      timeOut: { not: null },
      user:    userWhere,
    },
    select: { id: true, punchType: true, timeIn: true, userId: true },
  });

  if (timeLogs.length === 0) {
    console.log(`[ℹ️  Sync] No time logs found for cutoff ${cutoffPeriodId}`);
    return 0;
  }

  // Driver/Aide punches (DRIVER_AIDE = full AM+Regular+PM day, DRIVER_AIDE_AM/PM = single-route
  // day) get one segment record per DRIVER_SEGMENT_MAP entry; all others get 1 record
  // (segmentType = null). Clean up stale null-segmentType records for these logs before
  // inserting — a previous sync (or an older approval, e.g. a Request Punch approved before
  // BB-065 added AM/PM segment support) may have created a single segmentType:null record,
  // which would become an orphan alongside the proper segment records.
  const driverAideLogs = timeLogs.filter((l) => isDriverSegmentPunchType(l.punchType));
  const driverAideIds  = driverAideLogs.map((l) => l.id);

  if (driverAideIds.length > 0) {
    await prisma.timeLogApproval.deleteMany({
      where: {
        cutoffPeriodId,
        timeLogId:   { in: driverAideIds },
        segmentType: null,
        status:      "pending",
      },
    });
  }

  // Pre-resolve segment boundaries for Driver/Aide logs so segmentStart / segmentEnd
  // are populated on the approval record at creation time.
  const segBoundaries = await resolveDriverAideSegments(driverAideLogs, companyId);

  // Driver/Aide punches get one segment record per DRIVER_SEGMENT_MAP entry; all others
  // get 1 record (segmentType = null)
  const approvalData = timeLogs.flatMap((log) => {
    const segmentTypes = DRIVER_SEGMENT_MAP[log.punchType];
    if (segmentTypes) {
      const segs = segBoundaries[log.id] ?? {};
      return segmentTypes.map((segmentType) => {
        const seg = segs[segmentType] ?? null;
        return {
          id: randomUUID(), timeLogId: log.id, cutoffPeriodId, status: "pending", segmentType,
          segmentStart: seg?.start ?? null,
          segmentEnd:   seg?.end   ?? null,
        };
      });
    }
    return [{ id: randomUUID(), timeLogId: log.id, cutoffPeriodId, status: "pending", segmentType: null }];
  });

  const result = await prisma.timeLogApproval.createMany({
    data: approvalData,
    skipDuplicates: true,
  });

  if (result.count > 0) {
    console.log(`[✅ Sync] Created ${result.count} approval records for cutoff ${cutoffPeriodId}`);
  }

  return result.count;
}

/**
 * POST /api/cutoff-periods/:id/sync
 * Manually sync approval records — creates any missing TimeLogApproval rows.
 * Useful for cutoffs created before the auto-sync was added, or when new
 * punch logs are added after the cutoff was generated.
 */
const syncCutoffApprovals = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({
        message: `Cannot sync a ${cutoffPeriod.status} cutoff period.`,
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { timeZone: true },
    });
    const companyTimezone = company?.timeZone || "UTC";

    const created = await syncApprovalRecords(cutoffPeriod, companyId, companyTimezone);

    // Re-run computeTimeLogSummary for every timelog in the period.
    // Picks up shifts that were assigned after the original clock-out compute
    // (stale scheduledHours / lateHours / undertimeHours on the TimeLog record).
    const endDateStr  = new Date(cutoffPeriod.periodEnd).toISOString().slice(0, 10);
    const periodEndEOD = moment.tz(endDateStr, companyTimezone).endOf("day").toDate();

    // Recompute all completed timelogs in the period — picks up shifts assigned
    // after the original clock-out compute (stale scheduledHours, lateHours,
    // undertimeHours, lunchDeductionMinutes on the TimeLog record).
    const timelogs = await prisma.timeLog.findMany({
      where: {
        timeIn:  { gte: cutoffPeriod.periodStart, lte: periodEndEOD },
        timeOut: { not: null },
        user:    { companyId },
      },
      select: { id: true, userId: true, punchType: true },
    });

    let recomputed     = 0;
    let recomputeFailed = 0;
    const BATCH = 20;
    for (let i = 0; i < timelogs.length; i += BATCH) {
      const batch = timelogs.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (tl) => {
          await applyAutoBreaks(tl.id, tl.userId);
          await computeTimeLogSummary(tl.id);
          // DRIVER_AIDE: this recompute overwrites TimeLog.*SegmentHours with raw,
          // grace-unaware values. If all 3 segments are already approved, immediately
          // re-sync the approved (grace/raw-aware) actualHours back — otherwise this
          // routine recompute silently clobbers already-correct payroll display data
          // (see BB-040 backjob).
          if (tl.punchType === "DRIVER_AIDE") {
            await syncApprovedSegmentsToTimeLog(tl.id, cutoffPeriod.id);
          } else if (tl.punchType === "REGULAR") {
            // Same clobber risk for REGULAR: computeTimeLogSummary above just
            // overwrote netWorkedHours with the raw pre-approval value, discarding
            // an already-approved actualHours that may legitimately differ (e.g.
            // Raw-mode approval doesn't apply the early-clock-in grace snap).
            const approval = await prisma.timeLogApproval.findFirst({
              where:  { timeLogId: tl.id, cutoffPeriodId: cutoffPeriod.id, status: "approved" },
              select: { actualHours: true },
            });
            if (approval?.actualHours != null) {
              await syncApprovedRegularToTimeLog(tl.id, parseFloat(approval.actualHours.toString()));
            }
          }
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") recomputed++;
        else {
          console.error(`[sync] recompute failed:`, r.reason?.message);
          recomputeFailed++;
        }
      }
    }

    const total = await prisma.timeLogApproval.count({
      where: { cutoffPeriodId: id },
    });

    // Recompute OT blocks for all employees in this cutoff — picks up any logic
    // changes (e.g. TRAINING exclusion) and resets changed blocks to pending.
    let otRecomputed = false;
    try {
      await recomputeAllOtForCutoff(id, companyId);
      otRecomputed = true;
    } catch (otErr) {
      console.error("[sync] OT recompute failed:", otErr.message);
    }

    const parts = [];
    if (created > 0)         parts.push(`${created} new approval record(s) created`);
    if (recomputed > 0)      parts.push(`${recomputed} time log(s) recomputed`);
    if (recomputeFailed > 0) parts.push(`${recomputeFailed} recompute(s) failed`);
    if (otRecomputed)        parts.push("OT blocks recomputed");

    return res.status(200).json({
      message: `Sync complete. ${parts.length > 0 ? parts.join(", ") + "." : "Already in sync — nothing to do."}`,
      data: { created, total, recomputed, recomputeFailed, otRecomputed },
    });
  } catch (error) {
    console.error("❌ syncCutoffApprovals:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * GET /api/cutoff-periods/:id/approvals?status=pending|approved|excluded
 * Get all approvals for a cutoff, optionally filtered by status.
 * ✅ AUTO-SYNC: if no approval records exist, creates them before querying.
 * ✅ 'rejected' normalized to 'excluded' in response.
 */
const getCutoffApprovals = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, employeeId } = req.query;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    // Fetch company settings up front — companyTimezone is needed by the auto-sync
    // EOD calculation before any other company-dependent logic runs.
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { gracePeriodMinutes: true, timeZone: true, otBasis: true, dailyOtThresholdHours: true, cutoffOtThresholdHours: true, leaveConflictAutoRevert: true },
    });
    const gracePeriodMinutes     = company?.gracePeriodMinutes ?? 15;
    const companyTimezone        = company?.timeZone || "America/Los_Angeles";
    const otBasis                = company?.otBasis || "daily";
    const dailyOtThresholdHours  = parseFloat(company?.dailyOtThresholdHours  ?? 8);
    const cutoffOtThresholdHours = parseFloat(company?.cutoffOtThresholdHours ?? 80);

    // ✅ AUTO-SYNC: if this is an open cutoff with no approval records yet,
    // create them now. Covers manually created cutoffs and backfilled periods.
    if (cutoffPeriod.status === "open") {
      const existingCount = await prisma.timeLogApproval.count({
        where: { cutoffPeriodId: id },
      });
      if (existingCount === 0) {
        await syncApprovalRecords(cutoffPeriod, companyId, companyTimezone);
      } else {
        // ✅ BACKFILL: update any existing DRIVER_AIDE approval records that were
        // created before segmentStart/segmentEnd were populated (e.g. via
        // createCutoffPeriod before this fix). Runs only when null values are found.
        const nullSegmentApprovals = await prisma.timeLogApproval.findMany({
          where: {
            cutoffPeriodId: id,
            segmentType:    { not: null },
            segmentStart:   null,
          },
          select: { id: true, segmentType: true, timeLogId: true, timeLog: { select: { timeIn: true, userId: true } } },
        });

        if (nullSegmentApprovals.length > 0) {
          // Deduplicate to unique timeLogs for batch resolution
          const uniqueLogs = [...new Map(
            nullSegmentApprovals.map((a) => [a.timeLogId, { id: a.timeLogId, timeIn: a.timeLog.timeIn, userId: a.timeLog.userId }])
          ).values()];

          const segBoundaries = await resolveDriverAideSegments(uniqueLogs, companyId);

          await Promise.all(
            nullSegmentApprovals.map((approval) => {
              const seg = segBoundaries[approval.timeLogId]?.[approval.segmentType] ?? null;
              if (!seg) return Promise.resolve();
              return prisma.timeLogApproval.update({
                where: { id: approval.id },
                data:  { segmentStart: seg.start, segmentEnd: seg.end },
              });
            })
          );

          console.log(`[✅ Backfill] Populated segmentStart/segmentEnd for ${nullSegmentApprovals.length} DRIVER_AIDE approval(s) in cutoff ${id}`);
        }
      }
    }

    // ✅ When filtering by 'excluded', also include legacy 'rejected'
    let statusFilter;
    if (status === "excluded") {
      statusFilter = { in: ["excluded", "rejected"] };
    } else if (status) {
      statusFilter = status;
    }

    const approvals = await prisma.timeLogApproval.findMany({
      where: {
        cutoffPeriodId: id,
        ...(statusFilter && { status: statusFilter }),
        ...(employeeId && { timeLog: { userId: employeeId } }),
      },
      include: APPROVAL_INCLUDE,
      orderBy: { timeLog: { timeIn: "asc" } },
    });

    const enriched = await enrichApprovals(approvals, gracePeriodMinutes, companyTimezone);

    // ✅ Normalize legacy 'rejected' → 'excluded' in response
    const normalized = enriched.map((a) => ({
      ...a,
      status: a.status === "rejected" ? "excluded" : a.status,
    }));

    // ✅ Fetch Leave records for this cutoff period
    // Includes: approved leaves (shown as leave rows + conflict detection)
    //           pending leaves (shown as warning tag on punch row)
    const userWhere = { companyId };
    if (cutoffPeriod.departmentId) userWhere.departmentId = cutoffPeriod.departmentId;

    const leaveRecords = await prisma.leave.findMany({
      where: {
        status:    { in: ["approved", "pending"] },
        startDate: { lte: cutoffPeriod.periodEnd   },
        endDate:   { gte: cutoffPeriod.periodStart },
        User:      userWhere,
      },
      include: {
        User: {
          select: {
            id: true,
            email: true,
            username: true,
            profile: true,
            companyId: true,
            departmentId: true,
          },
        },
      },
      orderBy: { startDate: "asc" },
    });

    // ✅ Resolve leave type names — leaveType field may store a LeavePolicy ID
    // Fetch all LeavePolicy records once and build a lookup map
    const leavePolicies = await prisma.leavePolicy.findMany({
      where: { companyId },
      select: { id: true, leaveType: true },
    });
    const leavePolicyMap = Object.fromEntries(leavePolicies.map((p) => [p.id, p.leaveType]));

    // Helper: resolve leaveType string — if it looks like a cuid, look up the name
    const resolveLeaveType = (rawType) => {
      if (!rawType) return "Leave";
      // cuid pattern: starts with 'c' followed by ~24 alphanumeric chars
      const looksLikeId = /^c[a-z0-9]{20,30}$/.test(rawType);
      return looksLikeId ? (leavePolicyMap[rawType] || "Leave") : rawType;
    };

    // ✅ Attach pending leave warnings to matching punch records
    // ✅ Attach conflict flag when approved leave overlaps same day as punch
    const leaveContextDraft = normalized.map((approval) => {
      const timeIn    = new Date(approval.timeLog.timeIn);
      const userId    = approval.timeLog.userId;
      const shiftTz   = approval.schedule?.scheduledStart
        ? companyTimezone
        : companyTimezone;
      // ✅ FIX: Use shift timezone for punch date, plain ISO strings for leave dates.
      // Leave dates are calendar dates — timezone-converting them shifts them by 1 day.
      const punchDate = moment.tz(timeIn, companyTimezone).format("YYYY-MM-DD");

      const dayLeaves = leaveRecords.filter((leave) => {
        if (leave.userId !== userId) return false;
        // Read leave date as plain ISO string — no timezone conversion
        const leaveStart = (leave.startDate instanceof Date
          ? leave.startDate.toISOString()
          : String(leave.startDate)).split("T")[0];
        const leaveEnd = (leave.endDate instanceof Date
          ? leave.endDate.toISOString()
          : String(leave.endDate)).split("T")[0];
        return punchDate >= leaveStart && punchDate <= leaveEnd;
      });

      const approvedLeave = dayLeaves.find((l) => l.status === "approved");
      const pendingLeave  = dayLeaves.find((l) => l.status === "pending");

      return { approval, timeIn, userId, punchDate, approvedLeave, pendingLeave };
    });

    // BB-054: a leave can now exclude specific shifts on a multi-shift day
    // (Leave.excludedShiftIds). A punch on the shift the employee kept working
    // isn't actually a conflict — only override away from the date-only match
    // above when the punch's own UserShift is one the leave explicitly
    // excluded. Batch the lookup for every affected user/date pair rather than
    // querying per approval.
    const shiftAwareChecks = leaveContextDraft.filter(
      (d) => d.approvedLeave && Array.isArray(d.approvedLeave.excludedShiftIds) && d.approvedLeave.excludedShiftIds.length > 0
    );
    const shiftsByUserDate = new Map(); // `${userId}_${dateStr}` -> UserShift[] (id, shift window)
    if (shiftAwareChecks.length > 0) {
      const userIds = [...new Set(shiftAwareChecks.map((d) => d.userId))];
      const dates   = shiftAwareChecks.map((d) => new Date(`${d.punchDate}T00:00:00.000Z`));
      const minDate = new Date(Math.min(...dates));
      const maxDate = new Date(Math.max(...dates));
      const candidateShifts = await prisma.userShift.findMany({
        where: {
          userId:       { in: userIds },
          assignedDate: { gte: minDate, lte: maxDate },
          status:       { not: "cancelled" },
        },
        select: {
          id: true, userId: true, assignedDate: true,
          shift: { select: { startTime: true, endTime: true, crossesMidnight: true } },
        },
      });
      for (const us of candidateShifts) {
        if (!us.shift) continue;
        const dateStr = us.assignedDate.toISOString().split("T")[0];
        const key = `${us.userId}_${dateStr}`;
        if (!shiftsByUserDate.has(key)) shiftsByUserDate.set(key, []);
        shiftsByUserDate.get(key).push(us);
      }
    }

    function _findPunchShift(userId, punchDate, timeIn) {
      const shifts = shiftsByUserDate.get(`${userId}_${punchDate}`);
      if (!shifts) return null;
      for (const us of shifts) {
        const start = combineDateTime(punchDate, us.shift.startTime, companyTimezone);
        let end     = combineDateTime(punchDate, us.shift.endTime, companyTimezone);
        if (us.shift.crossesMidnight || end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
        if (timeIn >= start && timeIn <= end) return us;
      }
      return null;
    }

    const withLeaveContext = leaveContextDraft.map(({ approval, timeIn, userId, punchDate, approvedLeave, pendingLeave }) => {
      let hasLeaveConflict = !!approvedLeave;
      if (hasLeaveConflict && approvedLeave.excludedShiftIds?.length > 0) {
        const punchShift = _findPunchShift(userId, punchDate, timeIn);
        if (punchShift && approvedLeave.excludedShiftIds.includes(punchShift.id)) {
          hasLeaveConflict = false; // punch is on the shift the employee excluded from leave — expected work, not a conflict
        }
      }

      return {
        ...approval,
        hasLeaveConflict,
        leaveRecord:      approvedLeave
          ? {
              id:                approvedLeave.id,
              leaveType:         approvedLeave.leaveType,
              status:            "approved",
              isPaid:            approvedLeave.isPaid,
              actualPaidHours:   approvedLeave.actualPaidHours,
              actualUnpaidHours: approvedLeave.actualUnpaidHours,
            }
          : null,
        pendingLeave: pendingLeave
          ? {
              id:        pendingLeave.id,
              leaveType: pendingLeave.leaveType,
              status:    "pending",
              isPaid:    pendingLeave.isPaid,
            }
          : null,
      };
    });

    // BB-051: company-level toggle — when on, a detected punch-vs-leave conflict
    // auto-resolves in favor of the punch instead of waiting for manual review.
    // Reuses resolveConflict's existing mechanics unchanged (whole-leave cancel,
    // flat 8h refund, no ledger entry) — only the trigger (automatic vs. an
    // admin's manual PATCH) is new. userId is null (approvedBy) since no human
    // acted — same nullable field a manual resolution would populate.
    if (company?.leaveConflictAutoRevert) {
      const autoResolvable = withLeaveContext.filter((a) => a.hasLeaveConflict && a.status === "pending");
      for (const a of autoResolvable) {
        try {
          await getApprovalStrategy(companyId).resolveConflict(a.id, {
            cutoffPeriodId: id,
            choice: "punch",
            userId: null,
            companyId,
          });
          a.status = "approved";
          a.hasLeaveConflict = false;
          if (a.leaveRecord) {
            a.leaveRecord.status = "cancelled";
            // Keep leaveRecords in sync — the "standalone leave rows" pass below
            // reads it directly and would otherwise still treat this leave as
            // approved on its other (unpunched) days in the same range.
            const staleLeave = leaveRecords.find((l) => l.id === a.leaveRecord.id);
            if (staleLeave) staleLeave.status = "cancelled";
          }
        } catch (autoErr) {
          console.warn("[⚠️ BB-051] Auto-revert failed for approval", a.id, autoErr.message);
        }
      }
    }

    // ✅ Build standalone leave rows for approved leaves with NO matching punch
    const punchUserDates = new Set(
      normalized.map((a) => {
        const punchDate = moment.tz(a.timeLog.timeIn, companyTimezone).format("YYYY-MM-DD");
        return `${a.timeLog.userId}__${punchDate}`;
      })
    );

    // ✅ Real per-day paid/unpaid outcome — Leave.isPaid is only the submitted intent;
    // a paid leave that ran out of balance mid-day can have both an isPaid:true and
    // isPaid:false LeaveDay row on the same date (split day). Sum the paid portion only.
    const approvedLeaveIds = leaveRecords
      .filter((leave) => leave.status === "approved")
      .map((leave) => leave.id);

    const leaveDayRows = approvedLeaveIds.length
      ? await prisma.leaveDay.findMany({ where: { leaveId: { in: approvedLeaveIds } } })
      : [];

    const payableByLeaveDate = new Map(); // `${leaveId}_${YYYY-MM-DD}` -> paid hours
    for (const d of leaveDayRows) {
      if (!d.isPaid) continue;
      const dDateStr = (d.date instanceof Date ? d.date.toISOString() : String(d.date)).split("T")[0];
      const dKey = `${d.leaveId}_${dDateStr}`;
      payableByLeaveDate.set(dKey, (payableByLeaveDate.get(dKey) ?? 0) + Number(d.hours));
    }

    const standaloneLeavesNested = await Promise.all(
      leaveRecords
        .filter((leave) => leave.status === "approved")
        .map(async (leave) => {
          const rows = [];
          // ✅ FIX: Leave dates are calendar dates — read date part directly from ISO string.
          // NEVER timezone-convert: 2026-03-27T00:00:00Z in LA becomes Mar 26, giving wrong day.
          const startStr = (leave.startDate instanceof Date
            ? leave.startDate.toISOString()
            : String(leave.startDate)).split("T")[0];
          const endStr = (leave.endDate instanceof Date
            ? leave.endDate.toISOString()
            : String(leave.endDate)).split("T")[0];

          // Real per-day scheduled hours for this leave — same calculation used for
          // approval proration, so the client can show the employee's actual hours
          // for that day instead of a hardcoded default.
          const dailyHours = await calcDailyHours(leave.userId, startStr, endStr, {
            excludeShiftIds: Array.isArray(leave.excludedShiftIds) ? leave.excludedShiftIds : [],
            includeWeekends: leave.includeWeekends !== false,
          }).catch(() => []);
          const hoursByDate = new Map(dailyHours.map((d) => [d.date, d.hours]));

          let cursor = moment(startStr); // plain moment — no timezone
          const endDay = moment(endStr);

          while (cursor.isSameOrBefore(endDay)) {
            const dateStr = cursor.format("YYYY-MM-DD");
            const key = `${leave.userId}__${dateStr}`;
            // Only add if this day is within cutoff AND no punch exists
            const cursorDate = cursor.toDate();
            const inCutoff =
              cursorDate >= cutoffPeriod.periodStart &&
              cursorDate <= cutoffPeriod.periodEnd;
            if (inCutoff && !punchUserDates.has(key)) {
              // Legacy fallback: leaves approved before LeaveDay existed have no rows here —
              // fall back to leave.isPaid deciding full scheduled hours vs. 0, so we don't
              // silently zero out pre-existing paid leave.
              const hasLeaveDayRows = leaveDayRows.some((d) => d.leaveId === leave.id);
              const payableHours = hasLeaveDayRows
                ? (payableByLeaveDate.get(`${leave.id}_${dateStr}`) ?? 0)
                : (leave.isPaid ? (hoursByDate.get(dateStr) ?? 0) : 0);

              rows.push({
                _type:     "leave",
                id:        `leave_${leave.id}_${dateStr}`,
                leaveDate: dateStr,
                hours:     hoursByDate.get(dateStr) ?? null,
                payableHours,
                leave: {
                  ...leave,
                  leaveType: resolveLeaveType(leave.leaveType),
                },
                user: leave.User,
              });
            }
            cursor.add(1, "day");
          }
          return rows;
        })
    );
    const standaloneLeaves = standaloneLeavesNested.flat();

    // For B&C: batch-attach available shifts per punch so the client can render
    // the shift picker on "Approve Schedule" without a separate API call.
    if (BNC_COMPANY_IDS.has(companyId) && withLeaveContext.length > 0) {
      const userIds  = [...new Set(withLeaveContext.map((a) => a.timeLog.userId))];
      const dates    = withLeaveContext
        .map((a) => moment.tz(a.timeLog.timeIn, companyTimezone).format("YYYY-MM-DD"))
        .sort();
      const rangeStart = new Date(dates[0]);
      const rangeEnd   = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);

      const shiftRows = await prisma.userShift.findMany({
        where: {
          userId:       { in: userIds },
          assignedDate: { gte: rangeStart, lte: rangeEnd },
          status:       { not: "cancelled" },
        },
        include: {
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
        },
      });

      const shiftMap = {};
      shiftRows.forEach((s) => {
        const dateStr = (s.assignedDate instanceof Date
          ? s.assignedDate.toISOString()
          : String(s.assignedDate)).slice(0, 10);
        const key = `${s.userId}:${dateStr}`;
        if (!shiftMap[key]) shiftMap[key] = [];
        if (s.shift?.id && !shiftMap[key].some((x) => x.id === s.shift.id)) {
          // startTime/endTime are @db.Time(6) — Prisma returns Date objects that
          // serialize to ISO strings. Format as "HH:mm" for the shift picker display.
          const toHHMM = (t) => t instanceof Date
            ? `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`
            : String(t).slice(0, 5);
          shiftMap[key].push({
            id:        s.shift.id,
            shiftName: s.shift.shiftName,
            startTime: toHHMM(s.shift.startTime),
            endTime:   toHHMM(s.shift.endTime),
          });
        }
      });

      withLeaveContext.forEach((a) => {
        const punchDate = moment.tz(a.timeLog.timeIn, companyTimezone).format("YYYY-MM-DD");
        a.availableShifts = shiftMap[`${a.timeLog.userId}:${punchDate}`] ?? [];
      });
    }

    // Fetch OT blocks for companies that use block-based OT (B&C daily, DayCare cutoff-basis).
    // The client uses these to render the OT approval row per employee.
    const hasOtBlocks = BNC_COMPANY_IDS.has(companyId) || otBasis === "cutoff";
    let otBlocks = [];
    if (hasOtBlocks) {
      otBlocks = await prisma.cutoffOtBlock.findMany({
        where: { cutoffPeriodId: id },
        orderBy: [{ date: "asc" }],
        include: {
          user: {
            select: {
              id:       true,
              username: true,
              profile:  true,
            },
          },
        },
      });

      if (otBlocks.length > 0) {
        const otUserIds = [...new Set(otBlocks.map((b) => b.userId))];

        // One batch query — fetch ALL approved records (including training) so training
        // days can be shown as grayed-out excluded rows in the breakdown.
        const breakdownRecords = await prisma.timeLogApproval.findMany({
          where: {
            cutoffPeriodId: id,
            status:         "approved",
            timeLog:        { userId: { in: otUserIds } },
          },
          select: {
            actualHours:      true,
            approvedClockIn:  true,
            approvedClockOut: true,
            timeLog: { select: { userId: true, timeIn: true, punchType: true } },
          },
          orderBy: { timeLog: { timeIn: "asc" } },
        });

        // Group: byUser[userId][dateStr]{ otHours, trainingHours }
        // Training hours are tracked separately — they appear in the breakdown display
        // (labeled, not counted) but are excluded from the OT-eligible total below.
        // Supersedes Bug 6 (v2.10.18) — see docs/TIMEKEEPING_GLOSSARY.md.
        const byUser = {};
        for (const r of breakdownRecords) {
          if (!r.timeLog) continue;
          const uid        = r.timeLog.userId;
          const date       = moment.tz(r.timeLog.timeIn, companyTimezone).format("YYYY-MM-DD");
          const isTraining = r.timeLog.punchType === "TRAINING";
          const hours      = r.actualHours != null
            ? parseFloat(r.actualHours.toString())
            : r.approvedClockIn && r.approvedClockOut
              ? (new Date(r.approvedClockOut) - new Date(r.approvedClockIn)) / 3600000
              : 0;
          if (!byUser[uid])       byUser[uid]       = {};
          if (!byUser[uid][date]) byUser[uid][date] = { otHours: 0, trainingHours: 0 };
          if (isTraining) byUser[uid][date].trainingHours += hours;
          else            byUser[uid][date].otHours       += hours;
        }

        const otThreshold = otBasis === "cutoff"
          ? cutoffOtThresholdHours
          : dailyOtThresholdHours;

        otBlocks = otBlocks.map((block) => {
          const userDates = byUser[block.userId] || {};

          const buildDays = (dates) =>
            Object.entries(dates)
              .flatMap(([date, { otHours, trainingHours }]) => {
                const rows = [];
                if (otHours > 0)
                  rows.push({ date, hours: parseFloat(otHours.toFixed(2)),       isTraining: false });
                if (trainingHours > 0)
                  rows.push({ date, hours: parseFloat(trainingHours.toFixed(2)), isTraining: true  });
                return rows;
              })
              .sort((a, b) => a.date.localeCompare(b.date) || (a.isTraining ? 1 : -1));

          // For daily OT, scope breakdown to just the block's calendar date.
          const days = otBasis === "daily"
            ? (() => {
                const blockDate = moment.tz(block.date, companyTimezone).format("YYYY-MM-DD");
                const entry = userDates[blockDate];
                return entry ? buildDays({ [blockDate]: entry }) : [];
              })()
            : buildDays(userDates);

          // totalHours excludes training — mirrors computeOtForCutoffBasis. Training
          // rows still render in `days` for visibility but do not count toward the
          // OT-eligible total or the threshold comparison.
          const totalHours = parseFloat(
            days.filter((d) => !d.isTraining).reduce((s, d) => s + d.hours, 0).toFixed(2)
          );

          return {
            ...block,
            breakdown: {
              days,
              totalHours,
              threshold: otThreshold,
              otHours:   parseFloat(Math.max(0, totalHours - otThreshold).toFixed(2)),
            },
          };
        });
      }
    }

    return res.status(200).json({
      message:               "Approvals retrieved successfully.",
      data:                  withLeaveContext,
      leaves:                standaloneLeaves,
      otBlocks,
      gracePeriodMinutes,
      companyTimezone,
      otBasis,
      dailyOtThresholdHours,
      cutoffOtThresholdHours,
      isBNC:                 BNC_COMPANY_IDS.has(companyId),
      synced:                true,
    });
  } catch (error) {
    console.error("❌ getCutoffApprovals:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * GET /api/cutoff-periods/:id/approvals/pending
 * Get only pending approvals with full enrichment
 */
const getPendingApprovals = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { gracePeriodMinutes: true, timeZone: true },
    });
    const gracePeriodMinutes  = company?.gracePeriodMinutes ?? 15;
    const companyTimezone     = company?.timeZone || "America/Los_Angeles";

    const approvals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: id, status: "pending" },
      include: APPROVAL_INCLUDE,
      orderBy: { timeLog: { timeIn: "asc" } },
    });

    const enriched = await enrichApprovals(approvals, gracePeriodMinutes, companyTimezone);

    console.log("[✅ Pending approvals]", enriched.length);

    return res.status(200).json({
      message:             "Pending approvals retrieved successfully.",
      data:                enriched,
      gracePeriodMinutes,
    });
  } catch (error) {
    console.error("❌ getPendingApprovals:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * PATCH /api/cutoff-periods/:id/approvals/:approvalId
 * Approve, exclude, or reject a single time log.
 * Dispatches to the company-type strategy — DayCare or B&C.
 */
const updateSingleApproval = async (req, res) => {
  try {
    const { id, approvalId } = req.params;
    const { action, approvalMode, notes, reason, withOT, shiftId, editedClockIn, editedClockOut } = req.body;
    const userId    = req.user.id;
    const companyId = req.user.companyId;

    const validActions = ["approve", "exclude", "reject"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ message: "Action must be approve, exclude, or reject." });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot modify a ${cutoffPeriod.status} cutoff period.` });
    }

    const result = await getApprovalStrategy(companyId).approveSingle(approvalId, {
      cutoffPeriodId: id,
      action, approvalMode, userId, companyId, notes, reason, withOT, shiftId, editedClockIn, editedClockOut,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("❌ updateSingleApproval:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * PATCH /api/cutoff-periods/:id/approvals/bulk
 * Bulk approve or exclude multiple time logs.
 * Dispatches to the company-type strategy — DayCare or B&C.
 */
const bulkUpdateApprovals = async (req, res) => {
  try {
    const { id } = req.params;
    const { timeLogIds, action, approvalMode, notes } = req.body;
    const userId    = req.user.id;
    const companyId = req.user.companyId;

    if (!Array.isArray(timeLogIds) || timeLogIds.length === 0) {
      return res.status(400).json({ message: "timeLogIds must be a non-empty array." });
    }
    if (!["approve", "exclude", "reject"].includes(action)) {
      return res.status(400).json({ message: "Action must be approve or exclude." });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot modify a ${cutoffPeriod.status} cutoff period.` });
    }

    const result = await getApprovalStrategy(companyId).approveBulk(id, timeLogIds, {
      action, approvalMode, userId, companyId, notes,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("❌ bulkUpdateApprovals:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * PATCH /api/cutoff-periods/:id/approvals/:approvalId/conflict
 * Resolve a punch vs approved leave conflict.
 * Dispatches to the company-type strategy — DayCare or B&C.
 */
const resolveConflict = async (req, res) => {
  try {
    const { id, approvalId } = req.params;
    const { choice } = req.body;
    const userId    = req.user.id;
    const companyId = req.user.companyId;

    if (!["punch", "leave"].includes(choice)) {
      return res.status(400).json({ message: "Choice must be 'punch' or 'leave'." });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot modify a ${cutoffPeriod.status} cutoff period.` });
    }

    const result = await getApprovalStrategy(companyId).resolveConflict(approvalId, {
      cutoffPeriodId: id,
      choice, userId, companyId,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("❌ resolveConflict:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * GET /api/cutoff-periods/:id/summary
 * Payroll summary for a finalized/locked cutoff period
 */
const getCutoffSummary = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }

    const approvedApprovals = await prisma.timeLogApproval.findMany({
      where: { cutoffPeriodId: id, status: "approved" },
      include: {
        timeLog: {
          include: {
            user: { select: { id: true, email: true, username: true, profile: true } },
            overtime: {
              where: { status: "approved" },
              select: { id: true, requestedHours: true },
            },
          },
        },
      },
    });

    const employeeSummary = {};
    approvedApprovals.forEach((approval) => {
      const { timeLog } = approval;
      const userId = timeLog.userId;

      if (!employeeSummary[userId]) {
        employeeSummary[userId] = {
          userId,
          employee:     timeLog.user,
          regularHours: 0,
          overtimeHours: 0,
          totalHours:   0,
          approvedLogs: 0,
        };
      }

      const regularHours  = approval.scheduledHours || 0;
      const overtimeHours = timeLog.overtime.reduce(
        (sum, ot) => sum + parseFloat(ot.requestedHours || 0),
        0
      );

      employeeSummary[userId].regularHours  += regularHours;
      employeeSummary[userId].overtimeHours += overtimeHours;
      employeeSummary[userId].totalHours    += regularHours + overtimeHours;
      employeeSummary[userId].approvedLogs  += 1;
    });

    const summary = Object.values(employeeSummary).map((emp) => ({
      ...emp,
      regularHours:  parseFloat(emp.regularHours.toFixed(2)),
      overtimeHours: parseFloat(emp.overtimeHours.toFixed(2)),
      totalHours:    parseFloat(emp.totalHours.toFixed(2)),
    }));

    return res.status(200).json({
      message: "Cutoff summary generated successfully.",
      data: {
        cutoffPeriod: {
          id:           cutoffPeriod.id,
          periodStart:  cutoffPeriod.periodStart,
          periodEnd:    cutoffPeriod.periodEnd,
          paymentDate:  cutoffPeriod.paymentDate,
          frequency:    cutoffPeriod.frequency,
          status:       cutoffPeriod.status,
          departmentId: cutoffPeriod.departmentId,
        },
        employees: summary,
        totals: {
          totalEmployees:    summary.length,
          totalRegularHours: parseFloat(summary.reduce((s, e) => s + e.regularHours,  0).toFixed(2)),
          totalOvertimeHours:parseFloat(summary.reduce((s, e) => s + e.overtimeHours, 0).toFixed(2)),
          totalHours:        parseFloat(summary.reduce((s, e) => s + e.totalHours,    0).toFixed(2)),
        },
      },
    });
  } catch (error) {
    console.error("❌ getCutoffSummary:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

/**
 * PATCH /api/cutoff-periods/:id/ot-blocks/:otBlockId
 * Approve or exclude a computed OT block.
 */
const resetApproval = async (req, res) => {
  try {
    const { id: cutoffPeriodId, approvalId } = req.params;
    const companyId = req.user.companyId;

    const cutoffPeriod = await findCutoffForCompany(cutoffPeriodId, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot reset approvals in a ${cutoffPeriod.status} cutoff period.` });
    }

    const approval = await prisma.timeLogApproval.findUnique({
      where: { id: approvalId },
      select: {
        id: true, cutoffPeriodId: true, status: true, timeLogId: true,
        timeLog: { select: { id: true, originalTimeIn: true, originalTimeOut: true } },
      },
    });
    if (!approval || approval.cutoffPeriodId !== cutoffPeriodId) {
      return res.status(404).json({ message: "Approval not found in this cutoff period." });
    }
    if (approval.status !== "approved" && approval.status !== "excluded") {
      return res.status(400).json({ message: `Only approved or excluded records can be reset. Current status: ${approval.status}.` });
    }

    // Restore TimeLog to its original raw punch times if they were modified during
    // "Approve Schedule" mode (which snaps timeIn/timeOut to the shift window).
    // "Approve Raw" never modifies timeIn/timeOut so originalTimeIn will be set but equal.
    if (approval.timeLog?.originalTimeIn) {
      await prisma.timeLog.update({
        where: { id: approval.timeLogId },
        data: {
          timeIn:     approval.timeLog.originalTimeIn,
          timeOut:    approval.timeLog.originalTimeOut,
          isApproved: false,
        },
      });
    } else {
      await prisma.timeLog.update({
        where: { id: approval.timeLogId },
        data: { isApproved: false },
      });
    }

    // Always recompute after reset — restores pre-approval segment fields on the
    // TimeLog (driverAmSegmentHours, regularSegmentHours, driverPmSegmentHours,
    // netWorkedHours). Awaited so the response is not returned before the fields
    // are back to their computed state. No-ops if timeOut is still null.
    try {
      await computeTimeLogSummary(approval.timeLogId);
    } catch (e) {
      console.error("[reset] recompute failed after TimeLog restore:", e.message);
    }

    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:           "pending",
        actualHours:      null,
        approvedClockIn:  null,
        approvedClockOut: null,
        approvedBy:       null,
        approvedAt:       null,
        editedHours:      null,
        scheduledHours:   null,
      },
    });

    // Recompute OT — record is no longer approved, so the day total drops
    recomputeOtForTimeLog(approval.timeLogId, cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recompute failed after reset:", e.message)
    );

    console.log(`[🔄 Reset] Approval ${approvalId} reset to pending`);
    return res.status(200).json({ message: "Approval reset to pending.", data: updated });
  } catch (error) {
    console.error("❌ resetApproval:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

const approveOtBlock = async (req, res) => {
  try {
    const { id, otBlockId } = req.params;
    const { action, notes } = req.body;
    const userId    = req.user.id;
    const companyId = req.user.companyId;

    if (!["approve", "exclude"].includes(action)) {
      return res.status(400).json({ message: "Action must be 'approve' or 'exclude'." });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot modify a ${cutoffPeriod.status} cutoff period.` });
    }

    const block = await prisma.cutoffOtBlock.findUnique({
      where: { id: otBlockId },
    });
    if (!block || block.cutoffPeriodId !== id) {
      return res.status(404).json({ message: "OT block not found in this cutoff period." });
    }
    if (block.status !== "pending") {
      return res.status(400).json({ message: `Cannot modify an already ${block.status} OT block.` });
    }

    const updated = await prisma.cutoffOtBlock.update({
      where: { id: otBlockId },
      data: {
        status:     action === "approve" ? "approved" : "excluded",
        approvedBy: userId,
        approvedAt: new Date(),
        ...(notes && { notes }),
      },
    });

    console.log(`[✅ OT Block] ${action} — ${otBlockId}`);
    return res.status(200).json({
      message: action === "approve" ? "OT block approved." : "OT block excluded from payroll.",
      data:    updated,
    });
  } catch (error) {
    console.error("❌ approveOtBlock:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/cutoff-periods/:id/approvals/:approvalId/set-punch-type
 *
 * DayCare only. Changes a pending punch's type between REGULAR and TRAINING
 * before it is approved. Allows the admin to designate a training day during
 * cutoff review without touching any other approval state.
 *
 * Body: { punchType: "TRAINING" | "REGULAR" }
 */
const setPunchType = async (req, res) => {
  try {
    const { id, approvalId } = req.params;
    const { punchType }      = req.body;
    const companyId          = req.user.companyId;

    if (BNC_COMPANY_IDS.has(companyId)) {
      return res.status(400).json({ message: "Punch type designation is not available for this company type." });
    }

    const ALLOWED = ["TRAINING", "REGULAR"];
    if (!ALLOWED.includes(punchType)) {
      return res.status(400).json({ message: `punchType must be one of: ${ALLOWED.join(", ")}.` });
    }

    const cutoffPeriod = await findCutoffForCompany(id, companyId);
    if (!cutoffPeriod) {
      return res.status(404).json({ message: "Cutoff period not found." });
    }
    if (cutoffPeriod.status === "locked" || cutoffPeriod.status === "processed") {
      return res.status(400).json({ message: `Cannot modify a ${cutoffPeriod.status} cutoff period.` });
    }

    const approval = await prisma.timeLogApproval.findUnique({
      where:   { id: approvalId },
      include: { timeLog: { select: { id: true, punchType: true, userId: true, timeIn: true } } },
    });

    if (!approval || approval.cutoffPeriodId !== id) {
      return res.status(404).json({ message: "Approval record not found in this cutoff period." });
    }
    if (approval.status !== "pending") {
      return res.status(400).json({ message: `Cannot change punch type on an already ${approval.status} record.` });
    }

    const current = approval.timeLog?.punchType;
    if (!ALLOWED.includes(current)) {
      return res.status(400).json({ message: `Punch type ${current} cannot be changed via this endpoint.` });
    }
    if (current === punchType) {
      return res.status(400).json({ message: `Punch type is already ${punchType}.` });
    }

    await prisma.timeLog.update({
      where: { id: approval.timeLog.id },
      data:  { punchType },
    });

    // When reclassifying to TRAINING, auto-exclude any pending DRIVER_AIDE segment
    // approval records for the same user on the same local calendar day in this cutoff.
    let excludedSegmentCount = 0;
    if (punchType === "TRAINING") {
      const company = await prisma.company.findUnique({
        where:  { id: companyId },
        select: { timeZone: true },
      });
      const tz       = company?.timeZone || "America/Los_Angeles";
      const localDay = moment.tz(approval.timeLog.timeIn, tz);
      const dayStart = localDay.clone().startOf("day").toDate();
      const dayEnd   = localDay.clone().endOf("day").toDate();

      const driverTimeLogs = await prisma.timeLog.findMany({
        where: {
          userId:    approval.timeLog.userId,
          punchType: "DRIVER_AIDE",
          timeIn:    { gte: dayStart, lte: dayEnd },
        },
        select: { id: true },
      });

      if (driverTimeLogs.length > 0) {
        const driverIds = driverTimeLogs.map((tl) => tl.id);
        const result = await prisma.timeLogApproval.updateMany({
          where: {
            cutoffPeriodId: id,
            timeLogId:      { in: driverIds },
            segmentType:    { not: null },
            status:         "pending",
          },
          data: {
            status:     "excluded",
            approvedBy: req.user.id,
            approvedAt: new Date(),
            notes:      "Auto-excluded: day reclassified as Training",
          },
        });
        excludedSegmentCount = result.count;
        console.log(`[✅ DayCare] Auto-excluded ${result.count} driver segment(s) — day reclassified as Training`);
      }
    }

    console.log(`[✅ DayCare] Punch type ${current} → ${punchType} — ${approvalId}`);
    return res.status(200).json({
      message: `Punch type updated to ${punchType}.`,
      data:    { approvalId, previousPunchType: current, punchType, excludedSegmentCount },
    });
  } catch (error) {
    console.error("❌ setPunchType:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = {
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
};