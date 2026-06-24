// src/services/cutoff/daycareCutoffStrategy.js
//
// Cutoff approval strategy for DayCare / Driver-Aide companies.
// Handles: single approve/exclude, bulk approve, conflict resolution.
//
// FROZEN once extracted — changes here affect DayCare only.
// New company types → new strategy file, not a branch inside this one.

const { prisma }                = require("@config/connection");
const moment                    = require("moment-timezone");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");
const { recomputeOtForTimeLog,
        recomputeAllOtForCutoff } = require("./cutoffOtService");

// ── Strategy-level HTTP error ─────────────────────────────────────────────────
class StrategyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = "StrategyError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calculateHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return 0;
  return (new Date(timeOut) - new Date(timeIn)) / 3600000;
}

function combineDateTime(date, time, shiftTimezone = "America/Los_Angeles") {
  const dateStr = (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : moment.tz(date, shiftTimezone).format("YYYY-MM-DD");

  let timeStr;
  if (typeof time === "string") {
    timeStr = time;
  } else if (time instanceof Date) {
    const h = String(time.getUTCHours()).padStart(2, "0");
    const m = String(time.getUTCMinutes()).padStart(2, "0");
    const s = String(time.getUTCSeconds()).padStart(2, "0");
    timeStr = `${h}:${m}:${s}`;
  } else {
    timeStr = "00:00:00";
  }
  return moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", shiftTimezone).toDate();
}

async function fetchScheduleForDate(userId, dateOnly, userDepartmentId, companyId, localDateStr) {
  const SHIFT_SELECT = {
    id: true, shiftName: true, startTime: true,
    endTime: true, crossesMidnight: true, timeZone: true,
  };

  // UserShift — highest priority (explicit daily assignment)
  const userShift = await prisma.userShift.findFirst({
    where: {
      userId,
      assignedDate: {
        gte: dateOnly,
        lt:  new Date(dateOnly.getTime() + 24 * 60 * 60 * 1000),
      },
      status: { not: "cancelled" },
    },
    include: { shift: { select: SHIFT_SELECT } },
  });
  if (userShift) return userShift;

  // ShiftSchedule fallback — individual > department > all
  const orConditions = [
    { assignmentType: "individual", targetId: userId },
    { assignmentType: "all" },
  ];
  if (userDepartmentId) {
    orConditions.push({ assignmentType: "department", targetId: userDepartmentId });
  }

  const schedules = await prisma.shiftSchedule.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      OR:        orConditions,
      startDate: { lte: dateOnly },
      endDate:   { gte: dateOnly },
      isActive:  true,
    },
    include: { shift: { select: SHIFT_SELECT } },
  });

  if (!schedules.length) return null;

  const PRIORITY = { individual: 0, department: 1, all: 2 };
  schedules.sort((a, b) => (PRIORITY[a.assignmentType] ?? 99) - (PRIORITY[b.assignmentType] ?? 99));

  const dayOfWeek = localDateStr ? moment(localDateStr).day() : dateOnly.getDay();

  for (const schedule of schedules) {
    const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    if (days.includes(dayOfWeek)) {
      return { id: schedule.id, shift: schedule.shift, customStartTime: null, customEndTime: null };
    }
  }

  // Adjacent-day fallback — handles timezone offset edge cases
  for (const offset of [1, -1]) {
    const adjDay = localDateStr
      ? moment(localDateStr).add(offset, "day").day()
      : (dayOfWeek + offset + 7) % 7;
    for (const schedule of schedules) {
      const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
      if (days.includes(adjDay)) {
        return {
          id: schedule.id, shift: schedule.shift, customStartTime: null, customEndTime: null,
          _adjDate: moment(localDateStr || dateOnly).add(offset, "day").format("YYYY-MM-DD"),
        };
      }
    }
  }

  return null;
}

// ── Approval include for single-record operations ─────────────────────────────
const APPROVAL_INCLUDE = {
  timeLog: {
    include: {
      user: {
        select: {
          id: true,
          departmentId: true,
        },
      },
    },
  },
};

// ── approveSingle ─────────────────────────────────────────────────────────────

async function approveSingle(approvalId, {
  cutoffPeriodId, action, approvalMode, userId, companyId,
  notes, reason, withOT, editedClockIn, editedClockOut,
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
    console.log("[✅ DayCare] Record excluded", approvalId);
    return { message: "Record excluded from payroll.", data: updated };
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { gracePeriodMinutes: true, timeZone: true, defaultShiftHours: true },
  });
  const gracePeriodMinutes = company?.gracePeriodMinutes ?? 15;
  const graceMs            = (gracePeriodMinutes * 60 + 59) * 1000;
  const companyTz          = company?.timeZone || "America/Los_Angeles";
  const timeLog            = approval.timeLog;

  // ── TRAINING: cap at defaultShiftHours; use raw if punch is shorter ─────────
  if (timeLog.punchType === "TRAINING") {
    const maxHours      = parseFloat((company?.defaultShiftHours ?? 8).toString());
    const punchDuration = timeLog.timeOut
      ? calculateHours(timeLog.timeIn, timeLog.timeOut)
      : maxHours;
    const trainingHours = parseFloat(Math.min(punchDuration, maxHours).toFixed(2));
    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:           "approved",
        approvedBy:       userId,
        approvedAt:       new Date(),
        approvedClockIn:  new Date(timeLog.timeIn),
        approvedClockOut: timeLog.timeOut ? new Date(timeLog.timeOut) : null,
        scheduledHours:   trainingHours,
        actualHours:      trainingHours,
        ...(notes && { notes }),
      },
    });
    recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recompute failed after training approve:", e.message)
    );
    console.log("[✅ DayCare] Training record approved", approvalId, `(${trainingHours}h — punch ${punchDuration.toFixed(2)}h, cap ${maxHours}h)`);
    return { message: "Training record approved successfully.", data: updated };
  }

  // ── DRIVER_AIDE segment: trust stored computed segment hours ──────────────
  if (timeLog.punchType === "DRIVER_AIDE") {
    try { await computeTimeLogSummary(timeLog.id); } catch (_) {}

    const fresh = await prisma.timeLog.findUnique({
      where:  { id: timeLog.id },
      select: { driverAmSegmentHours: true, regularSegmentHours: true, driverPmSegmentHours: true },
    });
    const segHoursMap = {
      driver_am: fresh?.driverAmSegmentHours,
      regular:   fresh?.regularSegmentHours,
      driver_pm: fresh?.driverPmSegmentHours,
    };
    const segHours = segHoursMap[approval.segmentType];

    // "schedule" → snap clock-in to segment window start (full window credited).
    // "raw"      → use max(actual punch-in, segmentStart) — never go before the segment
    //              begins (the global clock-in precedes PM/Regular windows).
    const approvedIn  = approvalMode === "schedule" && approval.segmentStart
      ? new Date(approval.segmentStart)
      : approval.segmentStart
        ? new Date(Math.max(new Date(timeLog.timeIn).getTime(), new Date(approval.segmentStart).getTime()))
        : new Date(timeLog.timeIn);
    // PM is the last segment — Raw pays through actual clock-out (no subsequent segment to
    // capture that time). AM/Regular still cap at segmentEnd to avoid double-counting.
    const approvedOut = (approvalMode === "raw" && approval.segmentType === "driver_pm" && timeLog.timeOut)
      ? new Date(timeLog.timeOut)
      : approval.segmentEnd
        ? new Date(approval.segmentEnd)
        : (timeLog.timeOut ? new Date(timeLog.timeOut) : null);

    // Recalculate hours from actual approved window (raw in → segment end may differ).
    const rawSegHours = approvedIn && approvedOut
      ? calculateHours(approvedIn, approvedOut)
      : (segHours != null ? parseFloat(segHours.toString()) : null);

    // Regular (program) segment is fixed-rate: cap at defaultShiftHours.
    // Driving segments (driver_am, driver_pm) use actual elapsed time.
    const defaultShiftHours   = parseFloat((company?.defaultShiftHours ?? 8).toString());
    const approvedSegHours    = (approval.segmentType === "regular" && rawSegHours != null)
      ? Math.min(rawSegHours, defaultShiftHours)
      : rawSegHours;

    const updated = await prisma.timeLogApproval.update({
      where: { id: approvalId },
      data: {
        status:           "approved",
        approvedBy:       userId,
        approvedAt:       new Date(),
        approvedClockIn:  approvedIn,
        approvedClockOut: approvedOut,
        scheduledHours:   approvedSegHours != null ? parseFloat(approvedSegHours.toFixed(2)) : null,
        actualHours:      approvedSegHours != null ? parseFloat(approvedSegHours.toFixed(2)) : null,
        ...(notes && { notes }),
      },
    });
    recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
      console.error("[OT] recompute failed after segment approve:", e.message)
    );
    console.log("[✅ DayCare] Segment approved", approvalId, approval.segmentType, approvalMode === "schedule" ? "(segment window)" : "(raw times)");
    return { message: "Segment approved successfully.", data: updated };
  }

  // ── REGULAR ───────────────────────────────────────────────────────────────
  let finalClockIn  = editedClockIn  ? new Date(editedClockIn)  : new Date(timeLog.timeIn);
  let finalClockOut = editedClockOut ? new Date(editedClockOut) : (timeLog.timeOut ? new Date(timeLog.timeOut) : null);
  let scheduledHours = null;
  const rawClockIn  = new Date(timeLog.timeIn);

  const localDateStr        = moment.tz(timeLog.timeIn, companyTz).format("YYYY-MM-DD");
  const dateOnlyForSchedule = moment.tz(timeLog.timeIn, companyTz).startOf("day").toDate();

  const userShift = await fetchScheduleForDate(
    timeLog.userId, dateOnlyForSchedule, timeLog.user?.departmentId, companyId, localDateStr
  );

  if (approvalMode === "raw") {
    // ── APPROVE RAW: grace-period snap affects computation only ──────────────
    // The raw punch time (timeIn) is preserved in the DB and shown as-is.
    // If clock-in falls within the grace window, hours are credited from the
    // scheduled start — but the displayed clock-in remains the actual punch.
    if (userShift?.shift) {
      const startTime        = userShift.customStartTime || userShift.shift.startTime;
      const tz               = userShift.shift.timeZone  || companyTz;
      const scheduledClockIn = combineDateTime(localDateStr, startTime, tz);

      if (finalClockIn > scheduledClockIn) {
        const rawLateMs = finalClockIn - scheduledClockIn;
        if (rawLateMs <= graceMs) finalClockIn = scheduledClockIn;
      }
    }

    scheduledHours = finalClockIn && finalClockOut
      ? calculateHours(finalClockIn, finalClockOut)
      : null;

    await prisma.timeLog.update({
      where: { id: timeLog.id },
      data: {
        originalTimeIn:  timeLog.originalTimeIn  || timeLog.timeIn,
        originalTimeOut: timeLog.originalTimeOut || timeLog.timeOut,
        isApproved:      true,
      },
    });
  } else {
    // ── APPROVE SCHEDULE (default): snap to shift schedule ────────────────────
    if (userShift?.shift) {
      const startTime = userShift.customStartTime || userShift.shift.startTime;
      const endTime   = userShift.customEndTime   || userShift.shift.endTime;
      const tz        = userShift.shift.timeZone  || companyTz;

      const scheduledClockIn  = combineDateTime(localDateStr, startTime, tz);
      const scheduledClockOut = combineDateTime(localDateStr, endTime,   tz);
      if (userShift.shift.crossesMidnight) scheduledClockOut.setDate(scheduledClockOut.getDate() + 1);

      if (!editedClockIn) {
        if (finalClockIn > scheduledClockIn) {
          const rawLateMs = finalClockIn - scheduledClockIn;
          finalClockIn = rawLateMs <= graceMs ? scheduledClockIn : finalClockIn;
        } else {
          finalClockIn = scheduledClockIn;
        }
      }

      if (!editedClockOut) {
        if (finalClockOut) {
          finalClockOut = finalClockOut < scheduledClockOut ? finalClockOut : scheduledClockOut;
          if (withOT && timeLog.timeOut && new Date(timeLog.timeOut) > scheduledClockOut) {
            finalClockOut = new Date(timeLog.timeOut);
          }
        } else {
          finalClockOut = scheduledClockOut;
        }
      }

      scheduledHours = calculateHours(finalClockIn, finalClockOut);
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
  }

  const actualHours = finalClockOut ? calculateHours(finalClockIn, finalClockOut) : null;

  try {
    await computeTimeLogSummary(timeLog.id);
  } catch (err) {
    console.error(`[daycareCutoffStrategy] computeTimeLogSummary failed for ${timeLog.id}:`, err.message);
  }

  const updated = await prisma.timeLogApproval.update({
    where: { id: approvalId },
    data: {
      status:           "approved",
      approvedBy:       userId,
      approvedAt:       new Date(),
      approvedClockIn:  approvalMode === "raw" ? rawClockIn : finalClockIn,
      approvedClockOut: finalClockOut,
      scheduledHours:   scheduledHours != null ? parseFloat(scheduledHours.toFixed(2)) : null,
      actualHours:      actualHours    != null ? parseFloat(actualHours.toFixed(2))    : null,
      ...(notes && { notes }),
    },
  });

  recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
    console.error("[OT] recompute failed after regular approve:", e.message)
  );
  console.log("[✅ DayCare] Record approved", approvalId, approvalMode === "raw" ? "(raw)" : "(schedule)", withOT ? "(with OT)" : "");
  return { message: "Time log approved successfully.", data: updated };
}

// ── approveBulk ───────────────────────────────────────────────────────────────

async function approveBulk(cutoffPeriodId, timeLogIds, { action, approvalMode, userId, companyId, notes }) {
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

  // ── Bulk approve ──────────────────────────────────────────────────────────
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { gracePeriodMinutes: true, timeZone: true, defaultShiftHours: true },
  });
  const gracePeriodMinutes = company?.gracePeriodMinutes ?? 15;
  const graceMs            = (gracePeriodMinutes * 60 + 59) * 1000;
  const companyTz          = company?.timeZone || "America/Los_Angeles";
  const maxTrainingHours   = parseFloat((company?.defaultShiftHours ?? 8).toString());

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

      // ── TRAINING ────────────────────────────────────────────────────────
      if (timeLog.punchType === "TRAINING") {
        const punchDuration   = timeLog.timeOut
          ? calculateHours(timeLog.timeIn, timeLog.timeOut)
          : maxTrainingHours;
        const trainingHours   = parseFloat(Math.min(punchDuration, maxTrainingHours).toFixed(2));
        await prisma.timeLogApproval.update({
          where: { id: approval.id },
          data: {
            status:           "approved",
            approvedBy:       userId,
            approvedAt:       new Date(),
            approvedClockIn:  new Date(timeLog.timeIn),
            approvedClockOut: timeLog.timeOut ? new Date(timeLog.timeOut) : null,
            scheduledHours:   trainingHours,
            actualHours:      trainingHours,
            ...(notes && { notes }),
          },
        });
        successCount++;
        continue;
      }

      // ── DRIVER_AIDE ─────────────────────────────────────────────────────
      if (timeLog.punchType === "DRIVER_AIDE") {
        try { await computeTimeLogSummary(timeLog.id); } catch (_) {}

        const fresh = await prisma.timeLog.findUnique({
          where:  { id: timeLog.id },
          select: { driverAmSegmentHours: true, regularSegmentHours: true, driverPmSegmentHours: true },
        });
        const segHoursMap = {
          driver_am: fresh?.driverAmSegmentHours,
          regular:   fresh?.regularSegmentHours,
          driver_pm: fresh?.driverPmSegmentHours,
        };
        const segHours = segHoursMap[approval.segmentType];

        const approvedIn  = approvalMode === "schedule" && approval.segmentStart
          ? new Date(approval.segmentStart)
          : approval.segmentStart
            ? new Date(Math.max(new Date(timeLog.timeIn).getTime(), new Date(approval.segmentStart).getTime()))
            : new Date(timeLog.timeIn);
        const approvedOut = (approvalMode === "raw" && approval.segmentType === "driver_pm" && timeLog.timeOut)
          ? new Date(timeLog.timeOut)
          : approval.segmentEnd
            ? new Date(approval.segmentEnd)
            : (timeLog.timeOut ? new Date(timeLog.timeOut) : null);

        const rawSegHours = approvedIn && approvedOut
          ? calculateHours(approvedIn, approvedOut)
          : (segHours != null ? parseFloat(segHours.toString()) : null);

        // Regular (program) segment is fixed-rate: cap at defaultShiftHours.
        // Driving segments (driver_am, driver_pm) use actual elapsed time.
        const approvedSegHours = (approval.segmentType === "regular" && rawSegHours != null)
          ? Math.min(rawSegHours, maxTrainingHours)
          : rawSegHours;

        await prisma.timeLogApproval.update({
          where: { id: approval.id },
          data: {
            status:           "approved",
            approvedBy:       userId,
            approvedAt:       new Date(),
            approvedClockIn:  approvedIn,
            approvedClockOut: approvedOut,
            scheduledHours:   approvedSegHours != null ? parseFloat(approvedSegHours.toFixed(2)) : null,
            actualHours:      approvedSegHours != null ? parseFloat(approvedSegHours.toFixed(2)) : null,
            ...(notes && { notes }),
          },
        });
        successCount++;
        continue;
      }

      // ── REGULAR ─────────────────────────────────────────────────────────
      let finalClockIn  = new Date(timeLog.timeIn);
      let finalClockOut = timeLog.timeOut ? new Date(timeLog.timeOut) : null;
      let scheduledHours = null;
      const rawClockIn  = new Date(timeLog.timeIn);

      const localDateStr        = moment.tz(timeLog.timeIn, companyTz).format("YYYY-MM-DD");
      const dateOnlyForSchedule = moment.tz(timeLog.timeIn, companyTz).startOf("day").toDate();

      const userShift = await fetchScheduleForDate(
        timeLog.userId, dateOnlyForSchedule, timeLog.user?.departmentId, companyId, localDateStr
      );

      if (approvalMode === "raw") {
        // ── APPROVE RAW: grace-period snap affects computation only ───────────
        if (userShift?.shift) {
          const startTime        = userShift.customStartTime || userShift.shift.startTime;
          const tz               = userShift.shift.timeZone  || companyTz;
          const scheduledClockIn = combineDateTime(localDateStr, startTime, tz);

          if (finalClockIn > scheduledClockIn) {
            const rawLateMs = finalClockIn - scheduledClockIn;
            if (rawLateMs <= graceMs) finalClockIn = scheduledClockIn;
          }
        }

        scheduledHours = finalClockIn && finalClockOut
          ? calculateHours(finalClockIn, finalClockOut)
          : null;

        await prisma.timeLog.update({
          where: { id: timeLog.id },
          data: {
            originalTimeIn:  timeLog.originalTimeIn  || timeLog.timeIn,
            originalTimeOut: timeLog.originalTimeOut || timeLog.timeOut,
            isApproved:      true,
          },
        });
      } else {
        // ── APPROVE SCHEDULE (default): snap to shift schedule ────────────────
        if (userShift?.shift) {
          const startTime = userShift.customStartTime || userShift.shift.startTime;
          const endTime   = userShift.customEndTime   || userShift.shift.endTime;
          const tz        = userShift.shift.timeZone  || companyTz;

          const scheduledClockIn  = combineDateTime(localDateStr, startTime, tz);
          const scheduledClockOut = combineDateTime(localDateStr, endTime,   tz);
          if (userShift.shift.crossesMidnight) scheduledClockOut.setDate(scheduledClockOut.getDate() + 1);

          if (finalClockIn > scheduledClockIn) {
            const rawLateMs = finalClockIn - scheduledClockIn;
            finalClockIn = rawLateMs <= graceMs ? scheduledClockIn : finalClockIn;
          } else {
            finalClockIn = scheduledClockIn;
          }
          finalClockOut = finalClockOut
            ? (finalClockOut < scheduledClockOut ? finalClockOut : scheduledClockOut)
            : scheduledClockOut;

          scheduledHours = calculateHours(finalClockIn, finalClockOut);
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
      }

      const actualHours = finalClockOut ? calculateHours(finalClockIn, finalClockOut) : null;

      try { await computeTimeLogSummary(timeLog.id); } catch (_) {}

      await prisma.timeLogApproval.update({
        where: { id: approval.id },
        data: {
          status:           "approved",
          approvedBy:       userId,
          approvedAt:       new Date(),
          approvedClockIn:  approvalMode === "raw" ? rawClockIn : finalClockIn,
          approvedClockOut: finalClockOut,
          scheduledHours:   scheduledHours != null ? parseFloat(scheduledHours.toFixed(2)) : null,
          actualHours:      actualHours    != null ? parseFloat(actualHours.toFixed(2))    : null,
          ...(notes && { notes }),
        },
      });

      successCount++;
    } catch (err) {
      console.error(`[daycareCutoffStrategy] Bulk approve failed for approval ${approval.id}:`, err.message);
      failCount++;
    }
  }

  console.log(`[✅ DayCare] Bulk approve: ${successCount} approved, ${failCount} failed`);

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

  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { gracePeriodMinutes: true, timeZone: true },
  });
  const gracePeriodMinutes = company?.gracePeriodMinutes ?? 15;
  const graceMs            = (gracePeriodMinutes * 60 + 59) * 1000;
  const companyTz          = company?.timeZone || "America/Los_Angeles";

  // ── Honor leave: exclude the punch ───────────────────────────────────────
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
    console.log("[✅ DayCare] Conflict resolved — leave honored", approvalId);
    return {
      message: "Leave honored. Punch excluded from payroll.",
      data:    { choice, leaveKept: true, punchExcluded: true },
    };
  }

  // ── Honor punch: snap + recompute + cancel leave ──────────────────────────
  const localDateStr        = moment.tz(timeLog.timeIn, companyTz).format("YYYY-MM-DD");
  const dateOnlyForSchedule = moment.tz(timeLog.timeIn, companyTz).startOf("day").toDate();

  const userShift = await fetchScheduleForDate(
    timeLog.userId, dateOnlyForSchedule, timeLog.user?.departmentId, companyId, localDateStr
  );

  let finalClockIn   = new Date(timeLog.timeIn);
  let finalClockOut  = timeLog.timeOut ? new Date(timeLog.timeOut) : null;
  let scheduledHours = null;

  if (userShift?.shift) {
    const startTime = userShift.customStartTime || userShift.shift.startTime;
    const endTime   = userShift.customEndTime   || userShift.shift.endTime;
    const tz        = userShift.shift.timeZone  || companyTz;

    const scheduledClockIn  = combineDateTime(localDateStr, startTime, tz);
    const scheduledClockOut = combineDateTime(localDateStr, endTime,   tz);
    if (userShift.shift.crossesMidnight) scheduledClockOut.setDate(scheduledClockOut.getDate() + 1);

    if (finalClockIn > scheduledClockIn) {
      const rawLateMs = finalClockIn - scheduledClockIn;
      finalClockIn = rawLateMs <= graceMs ? scheduledClockIn : finalClockIn;
    } else {
      finalClockIn = scheduledClockIn;
    }
    finalClockOut = finalClockOut
      ? (finalClockOut < scheduledClockOut ? finalClockOut : scheduledClockOut)
      : scheduledClockOut;

    scheduledHours = calculateHours(finalClockIn, finalClockOut);
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

  try {
    await computeTimeLogSummary(timeLog.id);
  } catch (err) {
    console.error(`[daycareCutoffStrategy] computeTimeLogSummary failed for ${timeLog.id}:`, err.message);
  }

  await prisma.timeLogApproval.update({
    where: { id: approvalId },
    data: {
      status:           "approved",
      approvedBy:       userId,
      approvedAt:       new Date(),
      approvedClockIn:  finalClockIn,
      approvedClockOut: finalClockOut,
      scheduledHours:   scheduledHours != null ? parseFloat(scheduledHours.toFixed(2)) : null,
      notes:            "Conflict resolved — punch takes precedence",
    },
  });

  recomputeOtForTimeLog(timeLog.id, cutoffPeriodId, companyId).catch((e) =>
    console.error("[OT] recompute failed after conflict resolve:", e.message)
  );

  // Cancel leave + return credit (best-effort — don't fail the whole operation)
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
      await prisma.leave.update({
        where: { id: leave.id },
        data: {
          status:           "cancelled",
          approverComments: "Cancelled — conflict resolved in favour of punch during cutoff review",
        },
      });

      try {
        const leavePolicy = await prisma.leavePolicy.findFirst({
          where: { companyId, leaveType: leave.leaveType },
        });
        if (leavePolicy) {
          const leaveBalance = await prisma.leaveBalance.findFirst({
            where: { userId: timeLog.userId, policyId: leavePolicy.id },
          });
          if (leaveBalance) {
            await prisma.leaveBalance.update({
              where: { id: leaveBalance.id },
              data:  { balanceHours: { increment: 8 } },
            });
            console.log("[✅ DayCare] Leave credit returned to", timeLog.userId);
          }
        }
      } catch (creditErr) {
        console.warn("[⚠️  DayCare] Could not return leave credit:", creditErr.message);
      }

      leaveCancelled = true;
      console.log("[✅ DayCare] Leave cancelled", leave.id);
    }
  } catch (leaveErr) {
    console.warn("[⚠️  DayCare] Could not cancel leave record:", leaveErr.message);
  }

  console.log("[✅ DayCare] Conflict resolved — punch honored", approvalId);
  return {
    message: leaveCancelled
      ? "Punch honored. Leave credit returned to employee balance."
      : "Punch honored. Note: leave record could not be automatically cancelled — please review manually.",
    data: { choice, punchApproved: true, leaveCancelled },
  };
}

module.exports = { approveSingle, approveBulk, resolveConflict, StrategyError };
