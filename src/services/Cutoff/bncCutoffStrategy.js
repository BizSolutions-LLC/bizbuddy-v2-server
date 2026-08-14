// src/services/cutoff/bncCutoffStrategy.js
//
// Cutoff approval strategy for B&C Residential LLC.
//
// Four approval modes (passed as `approvalMode` in the request body):
//   "schedule" — snap to the admin-selected shift (shiftId required)
//   "raw"      — approve actual punch times as-is, no snapping
//   "edit"     — approve with admin-corrected times (editedClockIn / editedClockOut required)
//   default    — falls back to "raw" when approvalMode is absent
//
// Bulk approve always uses raw mode — shift picker cannot be applied per-record in bulk.
// Conflict resolution (honor punch) uses raw mode — times are already the employee's actual punch.
//
// rawOtMinutes is always null for B&C — OT is a day/week/cutoff aggregate, not per-punch.

const { prisma }                         = require("@config/connection");
const moment                             = require("moment-timezone");
const { computeTimeLogSummary }          = require("@services/timeLogComputeService");
const { combineDateWithTimeTz }          = require("@services/timeLogComputeUtils");
const { StrategyError }                  = require("./daycareCutoffStrategy");
const { fetchScheduleForDate }           = require("./shiftLookupUtils");
const { recomputeOtForTimeLog,
        recomputeAllOtForCutoff }        = require("./cutoffOtService");
const { creditLeaveOnConflict }          = require("./leaveConflictCredit");

// ── Raw-mode grace credit ──────────────────────────────────────────────────────
// Raw approval preserves the actual punch (TimeLog.timeIn/timeOut untouched), but
// if the punch falls within the company's grace period of the day's assigned
// shift start, the worked-hours figure should still credit from the scheduled
// start — mirroring the DayCare raw-approval behavior. netWorkedHours (from
// computeBnC) reflects the true elapsed punch time with zero grace credit, so
// this returns the extra hours to add back on top of it.
async function computeGraceCreditHours(timeLog, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { gracePeriodMinutes: true, timeZone: true },
  });
  const gracePeriodMinutes = company?.gracePeriodMinutes ?? 15;
  const graceMs            = (gracePeriodMinutes * 60 + 59) * 1000;
  const companyTz          = company?.timeZone || "America/Los_Angeles";

  const timeInDate          = new Date(timeLog.timeIn);
  const localDateStr        = moment.tz(timeInDate, companyTz).format("YYYY-MM-DD");
  const dateOnlyForSchedule = moment.tz(timeInDate, companyTz).startOf("day").toDate();

  const userShift = await fetchScheduleForDate(
    timeLog.userId, dateOnlyForSchedule, timeLog.user?.departmentId, companyId, localDateStr
  );
  if (!userShift?.shift) return 0;

  const startTime        = userShift.customStartTime || userShift.shift.startTime;
  const tz               = userShift.shift.timeZone  || companyTz;
  const scheduledClockIn = combineDateWithTimeTz(timeInDate, startTime, tz);

  const lateMs = timeInDate.getTime() - scheduledClockIn.getTime();
  return (lateMs > 0 && lateMs <= graceMs) ? lateMs / 3600000 : 0;
}

// ── Approval include ──────────────────────────────────────────────────────────
const APPROVAL_INCLUDE = {
  timeLog: {
    include: {
      user: {
        select: { id: true, departmentId: true },
      },
    },
  },
};

// ── Recompute helper — runs computeBnC and reads back fresh derived fields ────
async function recomputeAndRead(timeLogId) {
  try {
    await computeTimeLogSummary(timeLogId);
  } catch (err) {
    console.error(`[bncCutoffStrategy] computeTimeLogSummary failed for ${timeLogId}:`, err.message);
  }
  return prisma.timeLog.findUnique({
    where:  { id: timeLogId },
    select: { netWorkedHours: true, scheduledHours: true, timeIn: true, timeOut: true },
  });
}

// ── approveSingle ─────────────────────────────────────────────────────────────

async function approveSingle(approvalId, {
  cutoffPeriodId, action, approvalMode,
  userId, companyId,
  shiftId, notes, reason, editedClockIn, editedClockOut,
}) {
  const approval = await prisma.timeLogApproval.findUnique({
    where:   { id: approvalId },
    include: APPROVAL_INCLUDE,
  });

  if (!approval || approval.cutoffPeriodId !== cutoffPeriodId) {
    throw new StrategyError("Approval record not found in this cutoff period.", 404);
  }
  if (approval.status !== "pending") {
    throw new StrategyError(`Cannot modify an already ${approval.status} record.`);
  }

  // ── Exclude / reject ──────────────────────────────────────────────────────
  if (action === "exclude" || action === "reject") {
    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:     "excluded",
        approvedBy: userId,
        approvedAt: new Date(),
        notes:      reason || notes || (action === "reject" ? "Rejected by supervisor" : null),
      },
    });
    console.log("[✅ B&C] Record excluded", approvalId);
    return { message: "Record excluded from payroll.", data: updated };
  }

  // ── Approve — mode dispatch ───────────────────────────────────────────────
  const timeLog = approval.timeLog;

  // ── Mode: schedule — snap to the admin-selected shift ────────────────────
  if (approvalMode === "schedule") {
    if (!shiftId) {
      throw new StrategyError("shiftId is required for approve-schedule mode.");
    }

    const shift = await prisma.shift.findUnique({
      where:  { id: shiftId },
      select: { startTime: true, endTime: true, timeZone: true, crossesMidnight: true, shiftName: true },
    });
    if (!shift) {
      throw new StrategyError("Selected shift not found.", 404);
    }

    const company = await prisma.company.findUnique({
      where:  { id: companyId },
      select: { gracePeriodMinutes: true, timeZone: true },
    });
    const gracePeriodMinutes = company?.gracePeriodMinutes ?? 15;
    const graceMs            = (gracePeriodMinutes * 60 + 59) * 1000;
    const companyTz          = company?.timeZone || "America/Los_Angeles";
    const tz                 = shift.timeZone || companyTz;

    const timeInDate        = new Date(timeLog.timeIn);
    const scheduledClockIn  = combineDateWithTimeTz(timeInDate, shift.startTime, tz);
    let   scheduledClockOut = combineDateWithTimeTz(timeInDate, shift.endTime, tz);
    if (scheduledClockOut <= scheduledClockIn || shift.crossesMidnight) {
      scheduledClockOut = moment(scheduledClockOut).add(1, "day").toDate();
    }

    // Within grace → snap to scheduled start. Beyond grace → keep actual (employee is late).
    let finalClockIn = timeInDate;
    const rawLateMs  = timeInDate.getTime() - scheduledClockIn.getTime();
    if (rawLateMs <= graceMs) {
      finalClockIn = scheduledClockIn;
    }

    // Cap clock-out at shift end — employee cannot earn scheduled hours past it.
    let finalClockOut = timeLog.timeOut ? new Date(timeLog.timeOut) : scheduledClockOut;
    if (finalClockOut > scheduledClockOut) {
      finalClockOut = scheduledClockOut;
    }

    await prisma.timeLog.update({
      where: { id: timeLog.id },
      data: {
        originalTimeIn:  timeLog.originalTimeIn  || timeLog.timeIn,
        originalTimeOut: timeLog.originalTimeOut || timeLog.timeOut,
        timeIn:          finalClockIn,
        timeOut:         finalClockOut,
        isApproved:      true,
      },
    });

    const fresh = await recomputeAndRead(timeLog.id);

    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:           "approved",
        approvedBy:       userId,
        approvedAt:       new Date(),
        approvedClockIn:  finalClockIn,
        approvedClockOut: finalClockOut,
        scheduledHours:   fresh?.scheduledHours != null ? parseFloat(fresh.scheduledHours.toString()) : null,
        actualHours:      fresh?.netWorkedHours != null ? parseFloat(fresh.netWorkedHours.toString()) : null,
        ...(notes && { notes }),
      },
    });

    recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recompute failed after schedule approve:", e.message)
    );

    console.log(`[✅ B&C] Approve Schedule — ${shift.shiftName}`, approvalId);
    return { message: "Time log approved against schedule.", data: updated };
  }

  // ── Mode: edit — admin-corrected times ────────────────────────────────────
  if (approvalMode === "edit") {
    if (!editedClockIn || !editedClockOut) {
      throw new StrategyError("editedClockIn and editedClockOut are required for edit mode.");
    }

    const finalClockIn  = new Date(editedClockIn);
    const finalClockOut = new Date(editedClockOut);

    await prisma.timeLog.update({
      where: { id: timeLog.id },
      data: {
        originalTimeIn:  timeLog.originalTimeIn  || timeLog.timeIn,
        originalTimeOut: timeLog.originalTimeOut || timeLog.timeOut,
        timeIn:          finalClockIn,
        timeOut:         finalClockOut,
        isApproved:      true,
      },
    });

    const fresh = await recomputeAndRead(timeLog.id);

    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:           "approved",
        approvedBy:       userId,
        approvedAt:       new Date(),
        approvedClockIn:  finalClockIn,
        approvedClockOut: finalClockOut,
        scheduledHours:   fresh?.scheduledHours != null ? parseFloat(fresh.scheduledHours.toString()) : null,
        actualHours:      fresh?.netWorkedHours != null ? parseFloat(fresh.netWorkedHours.toString()) : null,
        ...(notes && { notes }),
      },
    });

    recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recompute failed after edit approve:", e.message)
    );

    console.log("[✅ B&C] Approve Edit", approvalId);
    return { message: "Time log approved with corrected times.", data: updated };
  }

  // ── Mode: raw (default) — actual punch times, no modification ────────────
  await prisma.timeLog.update({
    where: { id: timeLog.id },
    data:  { isApproved: true },
  });

  const fresh       = await recomputeAndRead(timeLog.id);
  const creditHours = await computeGraceCreditHours(timeLog, companyId);
  const actualHours = fresh?.netWorkedHours != null
    ? parseFloat((parseFloat(fresh.netWorkedHours.toString()) + creditHours).toFixed(2))
    : null;

  const updated = await prisma.timeLogApproval.update({
    where: { id: approvalId },
    data: {
      status:           "approved",
      approvedBy:       userId,
      approvedAt:       new Date(),
      approvedClockIn:  fresh?.timeIn  ? new Date(fresh.timeIn)  : new Date(timeLog.timeIn),
      approvedClockOut: fresh?.timeOut ? new Date(fresh.timeOut) : (timeLog.timeOut ? new Date(timeLog.timeOut) : null),
      scheduledHours:   fresh?.scheduledHours != null ? parseFloat(fresh.scheduledHours.toString()) : null,
      actualHours,
      ...(notes && { notes }),
    },
  });

  recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
    console.error("[OT] recompute failed after raw approve:", e.message)
  );

  console.log("[✅ B&C] Approve Raw", approvalId, creditHours > 0 ? `(+${creditHours.toFixed(2)}h grace credit)` : "");
  return { message: "Time log approved with raw punch times.", data: updated };
}

// ── approveBulk ───────────────────────────────────────────────────────────────
// Always uses raw mode — shift picker cannot be applied per-record in bulk.

async function approveBulk(cutoffPeriodId, timeLogIds, { action, userId, companyId, notes }) {
  // ── Exclude / reject ──────────────────────────────────────────────────────
  if (action === "exclude" || action === "reject") {
    const updated = await prisma.timeLogApproval.updateMany({
      where: {
        cutoffPeriodId,
        timeLogId: { in: timeLogIds },
        status:    "pending",
      },
      data: {
        status:     "excluded",
        approvedBy: userId,
        approvedAt: new Date(),
        ...(notes && { notes }),
      },
    });
    return {
      message: `${updated.count} record(s) excluded from payroll.`,
      data:    { count: updated.count },
    };
  }

  // ── Bulk approve (raw) ────────────────────────────────────────────────────
  const approvals = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId,
      timeLogId: { in: timeLogIds },
      status:    "pending",
    },
    include: APPROVAL_INCLUDE,
  });

  let successCount = 0;
  let failCount    = 0;

  for (const approval of approvals) {
    try {
      const timeLog = approval.timeLog;

      await prisma.timeLog.update({
        where: { id: timeLog.id },
        data:  { isApproved: true },
      });

      const fresh       = await recomputeAndRead(timeLog.id);
      const creditHours = await computeGraceCreditHours(timeLog, companyId);
      const actualHours = fresh?.netWorkedHours != null
        ? parseFloat((parseFloat(fresh.netWorkedHours.toString()) + creditHours).toFixed(2))
        : null;

      await prisma.timeLogApproval.update({
        where: { id: approval.id },
        data: {
          status:           "approved",
          approvedBy:       userId,
          approvedAt:       new Date(),
          approvedClockIn:  fresh?.timeIn  ? new Date(fresh.timeIn)  : new Date(timeLog.timeIn),
          approvedClockOut: fresh?.timeOut ? new Date(fresh.timeOut) : (timeLog.timeOut ? new Date(timeLog.timeOut) : null),
          scheduledHours:   fresh?.scheduledHours != null ? parseFloat(fresh.scheduledHours.toString()) : null,
          actualHours,
          ...(notes && { notes }),
        },
      });

      successCount++;
    } catch (err) {
      console.error(`[bncCutoffStrategy] Bulk approve failed for approval ${approval.id}:`, err.message);
      failCount++;
    }
  }

  console.log(`[✅ B&C] Bulk approve (raw): ${successCount} approved, ${failCount} failed`);

  if (successCount > 0) {
    recomputeAllOtForCutoff(cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recomputeAllOt failed after bulk approve:", e.message)
    );
  }

  return {
    message: `${successCount} time log(s) approved successfully.${failCount > 0 ? ` ${failCount} failed.` : ""}`,
    data:    { approved: successCount, failed: failCount },
  };
}

// ── resolveConflict ───────────────────────────────────────────────────────────
// Honor punch uses raw approval — no snapping on conflict resolution.

async function resolveConflict(approvalId, { cutoffPeriodId, choice, userId, companyId }) {
  const approval = await prisma.timeLogApproval.findUnique({
    where:   { id: approvalId },
    include: APPROVAL_INCLUDE,
  });

  if (!approval || approval.cutoffPeriodId !== cutoffPeriodId) {
    throw new StrategyError("Approval record not found.", 404);
  }
  if (approval.status !== "pending") {
    throw new StrategyError(`Cannot resolve — record is already ${approval.status}.`);
  }

  const timeLog = approval.timeLog;

  // ── Honor leave ───────────────────────────────────────────────────────────
  if (choice === "leave") {
    await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:     "excluded",
        approvedBy: userId,
        approvedAt: new Date(),
        notes:      "Conflict resolved — leave takes precedence",
      },
    });
    console.log("[✅ B&C] Conflict resolved — leave honored", approvalId);
    return {
      message: "Leave honored. Punch excluded from payroll.",
      data:    { choice, leaveKept: true, punchExcluded: true },
    };
  }

  // ── Honor punch: raw approval + cancel leave ──────────────────────────────
  await prisma.timeLog.update({
    where: { id: timeLog.id },
    data:  { isApproved: true },
  });

  const fresh       = await recomputeAndRead(timeLog.id);
  const creditHours = await computeGraceCreditHours(timeLog, companyId);
  const actualHours = fresh?.netWorkedHours != null
    ? parseFloat((parseFloat(fresh.netWorkedHours.toString()) + creditHours).toFixed(2))
    : null;

  await prisma.timeLogApproval.update({
    where: { id: approvalId },
    data: {
      status:           "approved",
      approvedBy:       userId,
      approvedAt:       new Date(),
      approvedClockIn:  fresh?.timeIn  ? new Date(fresh.timeIn)  : new Date(timeLog.timeIn),
      approvedClockOut: fresh?.timeOut ? new Date(fresh.timeOut) : (timeLog.timeOut ? new Date(timeLog.timeOut) : null),
      scheduledHours:   fresh?.scheduledHours != null ? parseFloat(fresh.scheduledHours.toString()) : null,
      actualHours,
      notes:            "Conflict resolved — punch takes precedence",
    },
  });

  // Cancel leave + return real credit (best-effort — don't fail the whole
  // operation; a leave-cancellation failure shouldn't roll back the punch
  // approval that already happened above).
  let leaveCancelled = false;
  try {
    const leave = await prisma.leave.findFirst({
      where: {
        userId:    timeLog.userId,
        status:    "approved",
        startDate: { lte: new Date(timeLog.timeIn) },
        endDate:   { gte: new Date(timeLog.timeIn) },
      },
    });

    if (leave) {
      leaveCancelled = await prisma.$transaction((tx) =>
        creditLeaveOnConflict(tx, { leave, userId })
      );
      if (leaveCancelled) console.log("[✅ B&C] Leave cancelled and credit reconciled", leave.id);
    }
  } catch (leaveErr) {
    console.error("[⚠️  B&C] Could not cancel leave record:", leaveErr.message);
  }

  console.log("[✅ B&C] Conflict resolved — punch honored", approvalId);
  return {
    message: leaveCancelled
      ? "Punch honored. Leave credit returned to employee balance."
      : "Punch honored. Note: leave record could not be automatically cancelled — please review manually.",
    data: { choice, punchApproved: true, leaveCancelled },
  };
}

module.exports = { approveSingle, approveBulk, resolveConflict };
