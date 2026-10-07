// src/services/timeLogComputeService.js
//
// Single source of truth for all TimeLog derived field computation.
//
// RULES:
//   - Raw timeIn / timeOut are NEVER modified here. They are immutable after creation.
//   - All shift times are resolved in company.timeZone (PDT / America/Los_Angeles).
//     The server's local timezone (Asia/Manila) is never used.
//   - This function is the ONLY place that writes the derived fields:
//       lateHours, undertimeHours, netWorkedHours,
//       lunchDeductionMinutes, totalBreakMinutes,
//       regularSegmentHours, driverAmSegmentHours, driverPmSegmentHours,
//       rawOtMinutes, calculatedAt
//   - Safe to call multiple times on the same record — always produces the same
//     result for the same inputs (idempotent).
//
// TRIGGERS:
//   1. Clock-out   — called immediately after timeOut is recorded
//   2. Admin edit  — called after any correction to timeIn / timeOut / breaks
//   3. Backfill    — called from scripts/backfill-timelog-compute.js for historical records
//   4. Cutoff recompute — called per-record before a cutoff period is locked
//
// SHIFT CATALOG DEPENDENCY:
//   Segment hours and rawOtMinutes for Driver/Aide employees rely on shift
//   boundaries resolved from the company's Shift catalog. Assigned employees
//   (those with the relevant UserShifts for the day) resolve boundaries directly
//   from their UserShifts. Unassigned employees (e.g. Regular-only employee who
//   covered a Driver PM slot) fall back to a catalog lookup by exact shift name.
//
//   The canonical shift names this service depends on are:
//     "Regular Shift"
//     "Driver/Aide AM Shift"
//     "Driver/Aide PM Shift"
//
//   If any of these names are changed or deleted in the admin shift catalog,
//   the affected segment hours will be null and a warning will be written to
//   the server log. The assigned driver path is unaffected by catalog renames.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { lunchOverlapMs } = require("./timeLogComputeUtils");

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Extracts the stored clock-time string (HH:mm:ss) from a Prisma @db.Time value.
 * Prisma returns db.Time columns as a Date anchored to 1970-01-01T00:00:00Z,
 * so getUTCHours/Minutes/Seconds gives the raw stored clock time.
 */
function timeStrFromDbTime(timeLikeDate) {
  const t = new Date(timeLikeDate);
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const ss = String(t.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Resolves the best valid IANA timezone string from the candidates provided.
 * Always falls back to "America/Los_Angeles" (PDT) — never the server timezone.
 */
function resolveTimezone(companyTz) {
  if (companyTz && moment.tz.zone(companyTz)) return companyTz;
  return "America/Los_Angeles";
}

/**
 * Combines a reference date (for the calendar date) with a @db.Time value,
 * interpreted in the given IANA timezone. Returns a UTC Date.
 */
function combineDateWithTimeTz(referenceDate, timeLikeDate, tz) {
  const dateOnly = moment(referenceDate).tz(tz).format("YYYY-MM-DD");
  const timeStr  = timeStrFromDbTime(timeLikeDate);
  return moment.tz(`${dateOnly} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", tz).toDate();
}

// ── Break helpers ─────────────────────────────────────────────────────────────

/**
 * Sums all completed coffee break durations in minutes.
 * Auto-injected breaks marked with { auto: true, deductible: false } are excluded
 * from the sum — they exist for paper trail only and must not affect payable hours.
 */
function sumCoffeeBreakMinutes(coffeeBreaks) {
  if (!Array.isArray(coffeeBreaks) || coffeeBreaks.length === 0) return 0;
  return coffeeBreaks.reduce((total, b) => {
    if (!b.start || !b.end) return total;
    if (b.auto && b.deductible === false) return total;
    const diffMs = new Date(b.end) - new Date(b.start);
    if (diffMs <= 0) return total;
    return total + diffMs / 60000;
  }, 0);
}

/**
 * Returns the lunch break duration in minutes, or 0 if no completed lunch break.
 */
function lunchBreakMinutes(lunchBreak) {
  if (!lunchBreak?.start || !lunchBreak?.end) return 0;
  const diffMs = new Date(lunchBreak.end) - new Date(lunchBreak.start);
  return diffMs > 0 ? diffMs / 60000 : 0;
}

// ── Segment helper ────────────────────────────────────────────────────────────

/**
 * Computes hours worked within a single shift segment window.
 * Clamps timeIn/timeOut to the segment boundary and returns hours (2dp).
 * Returns null if the segment boundary itself is null (missing shift data).
 * BB-092: subtracts the part of lunchBreak that falls inside the clamped window.
 */
function computeSegmentHours(timeIn, timeOut, segStart, segEnd, lunchBreak = null) {
  if (!segStart || !segEnd) return null;
  const start = Math.max(timeIn.getTime(),  segStart.getTime());
  const end   = Math.min(timeOut.getTime(), segEnd.getTime());
  if (end <= start) return 0;
  const lunchMs = lunchOverlapMs(lunchBreak, start, end);
  return +(Math.max(0, end - start - lunchMs) / 3600000).toFixed(2);
}

/**
 * Given a pre-fetched array of UserShifts (with shift included), returns the
 * one whose window has the greatest overlap with the punch [timeIn, timeOut].
 * Falls back to the shift with the closest startTime when no overlap exists.
 * Returns null for an empty array.
 *
 * Pure/sync — no DB calls. Used by both computeTimeLogSummary (B&C multi-shift)
 * and resolveShiftForTimeLog (auto-break service).
 */
function matchShiftToWindow(userShifts, timeIn, timeOut, tz) {
  if (userShifts.length === 0) return null;
  if (userShifts.length === 1) return userShifts[0];

  const timeInMs  = timeIn.getTime();
  const timeOutMs = timeOut.getTime();

  // Each shift is tested against two date anchors: the clock-in date and the
  // previous calendar day. This handles midnight-crossing shifts (e.g. 10 PM–2 AM)
  // where the employee clocks in after midnight — anchoring to yesterday produces
  // the correct [10 PM yesterday → 2 AM today] window instead of [10 PM today → 2 AM tomorrow].
  const prevDay = moment(timeIn).tz(tz).subtract(1, "day").toDate();
  const anchors = [timeIn, prevDay];

  // Precompute best overlap and closest-start-distance across both anchors for each shift.
  const windows = userShifts.map((us) => {
    if (!us.shift?.startTime || !us.shift?.endTime) {
      return { us, overlap: -1, closestDist: Infinity };
    }

    let bestOverlap = -1;
    let closestDist = Infinity;

    for (const anchor of anchors) {
      const segStart = combineDateWithTimeTz(anchor, us.shift.startTime, tz);
      let   segEnd   = combineDateWithTimeTz(anchor, us.shift.endTime, tz);
      if (segEnd <= segStart) segEnd = moment(segEnd).add(1, "day").toDate();

      const overlap = Math.max(
        0,
        Math.min(timeOutMs, segEnd.getTime()) - Math.max(timeInMs, segStart.getTime())
      );

      if (overlap > bestOverlap) bestOverlap = overlap;

      const dist = Math.abs(timeInMs - segStart.getTime());
      if (dist < closestDist) closestDist = dist;
    }

    return { us, overlap: bestOverlap, closestDist };
  });

  // Primary: shift with greatest overlap across both anchors
  const best = windows.reduce((a, b) => b.overlap > a.overlap ? b : a);
  if (best.overlap > 0) return best.us;

  // Fallback: no overlap found — shift whose start is closest to timeIn
  return windows.reduce((a, b) => b.closestDist < a.closestDist ? b : a).us;
}

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Computes all derived fields for a completed TimeLog record and writes them
 * back to the database.
 *
 * @param {string} timeLogId  - The TimeLog.id to compute
 * @returns {object}          - The derived fields that were written, or null if skipped
 *
 * SKIPS computation if:
 *   - timeOut is null (log is still active / employee still clocked in)
 *
 * netWorkedHours semantics by punch type:
 *   REGULAR        → gross (timeOut − timeIn) minus all break deductions
 *   DRIVER_AIDE_*  → sum of computed segment hours (schedule-bounded, OT excluded,
 *                    punched lunch subtracted from the segment it falls in — BB-092)
 *
 * rawOtMinutes semantics by punch type:
 *   REGULAR        → minutes past assigned shift end (grace-adjusted).
 *                    Falls back to timeIn + defaultShiftHours when no shift is assigned.
 *   DRIVER_AIDE_*  → minutes past Driver PM shift end (2:45 PM), grace-adjusted.
 *
 * FALLBACK behavior (no shift assigned for the day):
 *   - shiftStart / shiftEnd are treated as null (or catalog-resolved for DA types)
 *   - lateHours = null (cannot determine lateness without a shift)
 *   - undertimeHours = 0
 *   - netWorkedHours computed from raw punch times and breaks (Regular only)
 *   - rawOtMinutes for REGULAR computed against timeIn + defaultShiftHours
 *   - Segment hours / rawOtMinutes = null for DA if catalog shifts are also missing
 */
async function computeTimeLogSummary(timeLogId) {
  // ── 1. Fetch the TimeLog ────────────────────────────────────────────────────
  const log = await prisma.timeLog.findUnique({
    where: { id: timeLogId },
    include: {
      user: {
        select: { companyId: true, departmentId: true },
      },
    },
  });

  if (!log) {
    console.warn(`[computeTimeLogSummary] TimeLog ${timeLogId} not found.`);
    return null;
  }

  if (!log.user.companyId) {
    console.warn(`[computeTimeLogSummary] TimeLog ${timeLogId} belongs to a user with no companyId — skipping.`);
    return null;
  }

  if (!log.timeOut) return null;

  if (log.punchType === "TRAINING") {
    return require("@utils/punchTypeUtils").applyTrainingFlatHours(
      timeLogId,
      log.user.companyId,
    );
  }

  if (BNC_COMPANY_IDS.has(log.user.companyId)) {
    return require("./strategies/bncStrategy").computeBnC(timeLogId);
  }

  const timeIn  = new Date(log.timeIn);
  let   timeOut = new Date(log.timeOut);

  // Punch type flags — used throughout
  const isDriverAm  = log.punchType === "DRIVER_AIDE_AM"  || log.punchType === "DRIVER_AIDE";
  const isDriverPm  = log.punchType === "DRIVER_AIDE_PM"  || log.punchType === "DRIVER_AIDE";
  const isDriverLog = isDriverAm || isDriverPm;

  // ── 2. Fetch company settings ───────────────────────────────────────────────
  const company = await prisma.company.findUnique({
    where: { id: log.user.companyId },
    select: {
      timeZone:                  true,
      gracePeriodMinutes:        true,
      minimumLunchMinutes:       true,
      defaultShiftHours:         true,
      earlyClockInGraceMinutes:  true,
      earlyClockOutGraceMinutes: true,
    },
  });

  const tz                       = resolveTimezone(company?.timeZone);
  const gracePeriodMinutes        = company?.gracePeriodMinutes  ?? 15;
  const minimumLunchMins          = company?.minimumLunchMinutes ?? 60;
  const defaultShiftHours         = parseFloat(company?.defaultShiftHours ?? 8);
  const graceMs                   = (gracePeriodMinutes * 60 + 59) * 1000;
  const earlyClockInGraceMinutes   = company?.earlyClockInGraceMinutes  ?? null;
  const earlyClockOutGraceMinutes  = company?.earlyClockOutGraceMinutes ?? 20;

  // ── 3. Fetch ALL UserShifts for the clock-in date ───────────────────────────
  // Driver employees have three shifts per day (AM, Regular, PM). Fetching all
  // ensures we use the correct boundaries:
  //   - Earliest startTime → shiftStart (for lateHours)
  //   - Latest endTime     → shiftEnd   (for undertimeHours)
  //
  // assignedDate is @db.Date — stored as midnight UTC (e.g. 2026-04-23T00:00:00Z).
  // A timezone-adjusted dayStart (e.g. 07:00Z for LA) would exclude the current
  // day's records and capture the next day's instead. Use a UTC date range that
  // matches the local calendar date of the punch so the comparison is stable.
  const localDateStr = moment(timeIn).tz(tz).format("YYYY-MM-DD");
  const dayStart     = new Date(`${localDateStr}T00:00:00.000Z`);
  const dayEnd       = new Date(`${localDateStr}T23:59:59.999Z`);

  const userShifts = await prisma.userShift.findMany({
    where: {
      userId:       log.userId,
      assignedDate: { gte: dayStart, lte: dayEnd },
      status:       { not: "cancelled" },
    },
    include: { shift: true },
    orderBy: { shift: { startTime: "asc" } },
  });

  // ── 3b. ShiftSchedule fallback (non-driver only) ────────────────────────────
  // UserShift covers daily one-time assignments. Most employees are assigned via
  // ShiftSchedule (recurring). If no UserShift is found, look up ShiftSchedule
  // so scheduledHours / lateHours / undertimeHours are computed correctly.
  if (!isDriverLog && userShifts.length === 0) {
    const dayOfWeek = moment(localDateStr).day();
    const { companyId, departmentId } = log.user;

    const orConditions = [
      { assignmentType: "individual", targetId: log.userId },
      { assignmentType: "all" },
    ];
    if (departmentId) {
      orConditions.push({ assignmentType: "department", targetId: departmentId });
    }

    const schedules = await prisma.shiftSchedule.findMany({
      where: {
        companyId,
        OR: orConditions,
        startDate: { lte: dayStart },
        endDate:   { gte: dayStart },
        isActive:  true,
      },
      include: {
        shift: true,
      },
    });

    const PRIORITY = { individual: 0, department: 1, all: 2 };
    schedules.sort((a, b) => (PRIORITY[a.assignmentType] ?? 99) - (PRIORITY[b.assignmentType] ?? 99));

    const matched = schedules.find((s) =>
      Array.isArray(s.daysOfWeek) && s.daysOfWeek.includes(dayOfWeek)
    );

    if (matched?.shift) {
      // Synthesise a UserShift-shaped object so the rest of the function is unchanged
      userShifts.push({
        id:           matched.id,
        shift:        matched.shift,
        assignedDate: dayStart,
        customStartTime: null,
        customEndTime:   null,
      });
    }
  }

  // ── 4. Pre-fetch catalog shifts for any missing DA segment boundaries ────────
  // For Driver/Aide punch types, segment hours require boundaries for all active
  // segments (AM, Regular, PM). If the employee is unassigned for a segment (e.g.
  // Regular-only employee covering Driver PM), the boundary is resolved from the
  // company's Shift catalog by canonical name.
  //
  // This also ensures shiftEnd is correct for undertimeHours computation —
  // an unassigned DA_PM employee's effective day end is the Driver PM catalog end,
  // not the Regular shift end.

  const assignedShiftNames = new Set(
    userShifts.map((us) => us.shift?.shiftName).filter(Boolean)
  );

  const catalogShiftMap = {}; // { shiftName: { startTime, endTime } }

  if (isDriverLog) {
    const neededNames = [];
    if (!assignedShiftNames.has("Regular Shift"))
      neededNames.push("Regular Shift");
    if (isDriverAm && !assignedShiftNames.has("Driver/Aide AM Shift"))
      neededNames.push("Driver/Aide AM Shift");
    if (isDriverPm && !assignedShiftNames.has("Driver/Aide PM Shift"))
      neededNames.push("Driver/Aide PM Shift");

    if (neededNames.length > 0) {
      const catalogShifts = await prisma.shift.findMany({
        where: {
          companyId: log.user.companyId,
          shiftName: { in: neededNames },
        },
        select: { shiftName: true, startTime: true, endTime: true },
      });
      for (const s of catalogShifts) {
        catalogShiftMap[s.shiftName] = s;
      }

      const missing = neededNames.filter((n) => !catalogShiftMap[n]);
      if (missing.length > 0) {
        console.warn(
          `[computeTimeLogSummary] Catalog shifts not found for companyId=${log.user.companyId}: ` +
          `${missing.join(", ")}. Some segment hours will be null for ${timeLogId}.`
        );
      }
    }
  }

  // ── 4b. Early clock-out snap for DA/PM ──────────────────────────────────────
  // If a DRIVER_AIDE or DRIVER_AIDE_PM employee clocks out within
  // earlyClockOutGraceMinutes of their PM shift end, snap timeOut forward to
  // that boundary. The snapped value is persisted so all views and all computed
  // fields (grossHours, segmentHours, undertime, OT) reflect the adjustment.
  let timeOutSnapped = false;
  if (isDriverPm) {
    const earlyClockOutGraceMs = earlyClockOutGraceMinutes * 60 * 1000;
    const pmSrc =
      userShifts.find((us) => us.shift?.shiftName === "Driver/Aide PM Shift")?.shift ??
      catalogShiftMap["Driver/Aide PM Shift"] ??
      null;
    if (pmSrc?.endTime) {
      const pmEnd = combineDateWithTimeTz(timeIn, pmSrc.endTime, tz);
      if (timeOut < pmEnd) {
        const earlyByMs = pmEnd.getTime() - timeOut.getTime();
        if (earlyByMs <= earlyClockOutGraceMs) {
          timeOut = pmEnd;
          timeOutSnapped = true;
        }
      }
    }
  }

  // ── 5. Resolve overall shift boundaries (shiftStart / shiftEnd) ─────────────
  // dayCare (isDriverLog): aggregate all shifts → earliest start, latest end.
  //   One punch spans the full day (AM → Regular → PM).
  //
  // B&C REGULAR multi-shift: narrow to the one shift this punch belongs to
  //   via max-overlap matching. Each TimeLog computes independently against its
  //   own shift window — separate lateHours, undertimeHours, OT per punch.
  //
  // Single shift (any type): use that shift's boundaries directly.

  // For B&C: resolve which specific shift this punch belongs to
  const matchedUserShift = (!isDriverLog && userShifts.length > 1)
    ? matchShiftToWindow(userShifts, timeIn, timeOut, tz)
    : null;

  // effectiveShifts: the shift(s) used for boundaries and scheduledHours
  const effectiveShifts = matchedUserShift ? [matchedUserShift] : userShifts;

  let shiftStart = null;
  let shiftEnd   = null;

  if (effectiveShifts.length > 0) {
    const firstShift = effectiveShifts[0];
    if (firstShift.shift?.startTime) {
      shiftStart = combineDateWithTimeTz(timeIn, firstShift.shift.startTime, tz);
    }

    let latestEndDate = null;
    for (const us of effectiveShifts) {
      if (!us.shift?.endTime) continue;
      const endDate = combineDateWithTimeTz(timeIn, us.shift.endTime, tz);
      if (!latestEndDate || endDate > latestEndDate) latestEndDate = endDate;
    }
    if (latestEndDate) {
      shiftEnd = latestEndDate;
      if (shiftStart && shiftEnd <= shiftStart) {
        shiftEnd = moment(shiftEnd).add(1, "day").toDate();
      }
    }
  }

  // Extend shiftEnd for unassigned DA_PM employees using catalog Driver PM end
  if (
    isDriverPm &&
    !assignedShiftNames.has("Driver/Aide PM Shift") &&
    catalogShiftMap["Driver/Aide PM Shift"]?.endTime
  ) {
    const catalogPmEnd = combineDateWithTimeTz(
      timeIn,
      catalogShiftMap["Driver/Aide PM Shift"].endTime,
      tz
    );
    if (!shiftEnd || catalogPmEnd > shiftEnd) {
      shiftEnd = catalogPmEnd;
    }
  }

  // No shift at all — fall back to timeIn + defaultShiftHours
  if (!shiftEnd) {
    shiftEnd = new Date(timeIn.getTime() + defaultShiftHours * 60 * 60 * 1000);
  }

  // ── 5b. Early clock-in check ─────────────────────────────────────────────────
  // Determines whether this punch should be considered "too early."
  //
  // earlyClockInGraceMinutes (Company setting):
  //   null → always snap to shiftStart (unlimited grace; backwards-compatible default)
  //   N    → snap only when early by ≤ N min; flag as too early when early by > N min
  //
  // Effect on REGULAR: controls whether effectiveTimeIn snaps to shiftStart.
  // Effect on DRIVER_AIDE: flag only — segment clamping already excludes pre-shift time.
  const earlyClockInGraceMs = earlyClockInGraceMinutes != null
    ? earlyClockInGraceMinutes * 60 * 1000
    : Infinity; // null = always snap
  const earlyByMs       = shiftStart ? Math.max(0, shiftStart.getTime() - timeIn.getTime()) : 0;
  const isTooEarlyPunch = earlyByMs > 0 && isFinite(earlyClockInGraceMs) && earlyByMs > earlyClockInGraceMs;

  // ── 6. Compute grossHours ───────────────────────────────────────────────────
  // Raw timeOut − timeIn in hours. No timezone dependency — pure ms difference.
  // Counterpart to netWorkedHours (gross before deductions).
  const grossHours = +((timeOut.getTime() - timeIn.getTime()) / 3600000).toFixed(2);

  // ── 6b. Compute break totals ────────────────────────────────────────────────
  const coffeeBreakMins  = sumCoffeeBreakMinutes(log.coffeeBreaks);
  const lunchMins        = lunchBreakMinutes(log.lunchBreak);

  let lunchDeductionMins;
  if (log.autoLunchDeductionMinutes != null) {
    // Auto-injected deductible lunch — use the exact value set at injection time
    lunchDeductionMins = log.autoLunchDeductionMinutes;
  } else if (log.autoLunchApplied) {
    // Auto-injected but non-deductible — paper trail only, no pay impact
    lunchDeductionMins = 0;
  } else if (lunchMins > 0) {
    lunchDeductionMins = Math.max(lunchMins, minimumLunchMins);
  } else {
    lunchDeductionMins = minimumLunchMins;
  }

  const totalBreakMins = Math.round(coffeeBreakMins + lunchDeductionMins);

  // ── 7. Compute scheduledHours ───────────────────────────────────────────────
  // Sum of all assigned shift durations. For Driver/Aide this is the total of
  // all three segments. For single-shift REGULAR it is just that shift's window.
  // null when no shifts are assigned (no basis for a scheduled expectation).
  let scheduledHours = null;

  if (effectiveShifts.length > 0) {
    let totalScheduledMs = 0;
    const seenShiftIds   = new Set();
    for (const us of effectiveShifts) {
      if (!us.shift?.startTime || !us.shift?.endTime) continue;
      if (us.shift.id) {
        if (seenShiftIds.has(us.shift.id)) continue;
        seenShiftIds.add(us.shift.id);
      }
      const segStart = combineDateWithTimeTz(timeIn, us.shift.startTime, tz);
      let   segEnd   = combineDateWithTimeTz(timeIn, us.shift.endTime,   tz);
      if (segEnd <= segStart) segEnd = moment(segEnd).add(1, "day").toDate();
      totalScheduledMs += segEnd.getTime() - segStart.getTime();
    }
    if (totalScheduledMs > 0) {
      scheduledHours = +(totalScheduledMs / 3600000).toFixed(2);
    }
  }

  // ── 8. Compute lateHours ────────────────────────────────────────────────────
  // Grace period is a forgiveness threshold — within grace the employee is not
  // late at all (lateHours = 0). Once exceeded, the full raw lateness is charged
  // (no grace deduction from the late amount).
  let lateHours = null;

  if (shiftStart) {
    const rawLateMs = timeIn.getTime() - shiftStart.getTime();
    lateHours = rawLateMs > graceMs ? +(rawLateMs / 3600000).toFixed(2) : 0;
  }

  // ── 9. Compute undertimeHours ───────────────────────────────────────────────
  // Same threshold logic as lateHours — within grace the employee is not short,
  // once exceeded the full raw undertime is charged.
  const rawUndertimeMs = shiftEnd.getTime() - timeOut.getTime();
  const undertimeHours = rawUndertimeMs > graceMs ? +(rawUndertimeMs / 3600000).toFixed(2) : 0;

  // ── 10. Compute netWorkedHours and segment hours ────────────────────────────
  //
  // REGULAR punch type:
  //   netWorkedHours = gross (timeOut − timeIn) minus all break deductions.
  //   No segment fields — all remain null.
  //
  // DRIVER_AIDE_* punch types:
  //   Segment hours are computed per shift window (AM / Regular / PM).
  //   Each segment clamps timeIn/timeOut to the window boundaries so that:
  //     - Pre-schedule time (e.g. 7:31 AM before 8:00 AM Regular start) is excluded
  //     - Early departure is captured correctly per segment
  //     - Lunch inside the window is subtracted from that segment (BB-092)
  //   netWorkedHours = sum of segment hours (OT excluded — OT requires approval)
  //   rawOtMinutes   = minutes past Driver PM end, grace-adjusted

  let netWorkedHours       = null;
  let regularSegmentHours  = null;
  let driverAmSegmentHours = null;
  let driverPmSegmentHours = null;
  let rawOtMinutes         = null;

  if (!isDriverLog) {
    // ── Regular path ──────────────────────────────────────────────────────────
    // Snap effective start to shiftStart in two cases:
    //   1. Early clock-in within the early grace window (timeIn < shiftStart, not too early)
    //   2. Late clock-in within the grace period (timeIn > shiftStart but within graceMs)
    // isTooEarlyPunch = true means too far before shift — raw timeIn is kept for admin review.
    // The stored timeIn is NEVER modified here; only the local effectiveTimeIn changes.
    const lateByMs         = shiftStart ? Math.max(0, timeIn.getTime() - shiftStart.getTime()) : 0;
    const isLateWithinGrace = lateByMs > 0 && lateByMs <= graceMs;
    const effectiveTimeIn  = shiftStart && ((!isTooEarlyPunch && timeIn < shiftStart) || isLateWithinGrace)
      ? shiftStart
      : timeIn;
    const effectiveMs  = timeOut.getTime() - effectiveTimeIn.getTime();
    const deductionMs  = totalBreakMins * 60 * 1000;
    netWorkedHours     = +(Math.max(0, effectiveMs - deductionMs) / 3600000).toFixed(2);

    // rawOtMinutes = minutes past shift end, grace-adjusted.
    // shiftEnd is always resolved — either from the assigned shift's latest endTime,
    // or the fallback (timeIn + defaultShiftHours) for employees with no assigned shift.
    const otMs = timeOut.getTime() - shiftEnd.getTime() - graceMs;
    rawOtMinutes = otMs > 0 ? Math.round(otMs / 60000) : 0;

  } else {
    // ── Driver/Aide path ──────────────────────────────────────────────────────

    // Resolve boundary for a given segment — prefers assigned UserShift, falls
    // back to catalog entry.
    const resolveSegmentBoundary = (assignedName) => {
      const assigned = userShifts.find((us) => us.shift?.shiftName === assignedName);
      const source   = assigned?.shift ?? catalogShiftMap[assignedName] ?? null;
      if (!source?.startTime || !source?.endTime) return null;
      return {
        start: combineDateWithTimeTz(timeIn, source.startTime, tz),
        end:   combineDateWithTimeTz(timeIn, source.endTime,   tz),
      };
    };

    const regularSeg  = resolveSegmentBoundary("Regular Shift");
    const driverAmSeg = isDriverAm ? resolveSegmentBoundary("Driver/Aide AM Shift") : null;
    const driverPmSeg = isDriverPm ? resolveSegmentBoundary("Driver/Aide PM Shift") : null;

    // BB-092: each segment loses the part of the lunch punch inside its window
    // (lunch 08:17–08:46 → Regular; a lunch crossing a boundary is split).
    regularSegmentHours  = computeSegmentHours(timeIn, timeOut, regularSeg?.start,  regularSeg?.end,  log.lunchBreak);
    driverAmSegmentHours = computeSegmentHours(timeIn, timeOut, driverAmSeg?.start, driverAmSeg?.end, log.lunchBreak);
    driverPmSegmentHours = computeSegmentHours(timeIn, timeOut, driverPmSeg?.start, driverPmSeg?.end, log.lunchBreak);

    // netWorkedHours = sum of all resolved segments (pre-schedule time and lunch excluded)
    const segTotal = [regularSegmentHours, driverAmSegmentHours, driverPmSegmentHours]
      .filter((h) => h !== null)
      .reduce((sum, h) => sum + h, 0);
    netWorkedHours = +segTotal.toFixed(2);

    // Driver/Aide deducts only the punched (or deductible auto) lunch that falls
    // inside a segment — the company minimumLunchMinutes floor does not apply.
    // Store what was actually deducted so "Lunch Break" matches the hours.
    lunchDeductionMins = [regularSeg, driverAmSeg, driverPmSeg]
      .filter(Boolean)
      .reduce((sum, seg) => sum + lunchOverlapMs(
        log.lunchBreak,
        Math.max(timeIn.getTime(),  seg.start.getTime()),
        Math.min(timeOut.getTime(), seg.end.getTime()),
      ), 0) / 60000;

    // rawOtMinutes = minutes past Driver PM shift end, grace-adjusted
    if (driverPmSeg) {
      const otMs = timeOut.getTime() - driverPmSeg.end.getTime() - graceMs;
      rawOtMinutes = otMs > 0 ? Math.round(otMs / 60000) : 0;
    }
  }

  // ── 11. Write back to TimeLog ───────────────────────────────────────────────
  const derivedFields = {
    lateHours:             lateHours            !== null ? lateHours            : undefined,
    undertimeHours,
    netWorkedHours,
    lunchDeductionMinutes: Math.round(lunchDeductionMins),
    totalBreakMinutes:     Math.round(coffeeBreakMins),  // coffee only — lunch is separate
    regularSegmentHours:   regularSegmentHours  !== null ? regularSegmentHours  : undefined,
    driverAmSegmentHours:  driverAmSegmentHours !== null ? driverAmSegmentHours : undefined,
    driverPmSegmentHours:  driverPmSegmentHours !== null ? driverPmSegmentHours : undefined,
    rawOtMinutes:          rawOtMinutes         !== null ? rawOtMinutes         : undefined,
    scheduledHours:        scheduledHours       !== null ? scheduledHours       : undefined,
    grossHours,
    isTooEarlyPunch,
    calculatedAt:          new Date(),
    ...(timeOutSnapped && { timeOut }),
  };

  await prisma.timeLog.update({
    where: { id: timeLogId },
    data:  derivedFields,
  });

  console.log(
    `[computeTimeLogSummary] ✓ ${timeLogId}` +
    ` | punchType=${log.punchType}` +
    ` | lateHours=${lateHours ?? "n/a"}` +
    ` | undertime=${undertimeHours}h` +
    ` | gross=${grossHours}h` +
    ` | net=${netWorkedHours}h` +
    ` | scheduled=${scheduledHours ?? "n/a"}h` +
    ` | lunch=${Math.round(lunchDeductionMins)}min` +
    ` | rawOtMins=${rawOtMinutes ?? "n/a"}` +
    (isDriverLog
      ? ` | segs=[AM:${driverAmSegmentHours ?? "-"} REG:${regularSegmentHours ?? "-"} PM:${driverPmSegmentHours ?? "-"}]`
      : "") +
    (isTooEarlyPunch  ? ` | ⚠️ TOO_EARLY(${Math.round(earlyByMs / 60000)}min)` : "") +
    (timeOutSnapped   ? ` | ⏱️ CLOCK_OUT_SNAPPED` : "") +
    ` | tz=${tz}`
  );

  return derivedFields;
}

// ── Shift resolver ────────────────────────────────────────────────────────────

/**
 * Given a completed TimeLog's userId, timeIn, and timeOut, returns the
 * UserShift (with shift included) whose window has the greatest overlap with
 * the punch window — i.e. the shift the employee was actually working.
 *
 * Uses company timezone for day-boundary and shift-time resolution.
 * Falls back to closest shiftStart when no shift window overlaps at all
 * (e.g. employee clocked in outside every scheduled window).
 *
 * Falls back to ShiftSchedule (recurring assignments) when no UserShift is
 * found for the day — mirrors the same fallback in computeTimeLogSummary so
 * the auto-break service resolves the same shift as the compute service.
 *
 * Returns null when the employee has no shift assignment of any kind.
 */
async function resolveShiftForTimeLog(userId, timeIn, timeOut, companyTz) {
  const tz       = resolveTimezone(companyTz);
  const dayStart = moment(timeIn).tz(tz).startOf("day").toDate();
  const dayEnd   = moment(timeIn).tz(tz).endOf("day").toDate();

  const userShifts = await prisma.userShift.findMany({
    where: {
      userId,
      assignedDate: { gte: dayStart, lte: dayEnd },
      status:       { not: "cancelled" },
    },
    include: { shift: true },
    orderBy: { shift: { startTime: "asc" } },
  });

  // ShiftSchedule fallback — only when no daily UserShift exists.
  // Employees on recurring schedules have no UserShift record; without this
  // fallback the auto-break service would always return empty config for them.
  if (userShifts.length === 0) {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { companyId: true, departmentId: true },
    });

    if (user) {
      const localDateStr = moment(timeIn).tz(tz).format("YYYY-MM-DD");
      const dayOfWeek    = moment(localDateStr).day();

      const orConditions = [
        { assignmentType: "individual", targetId: userId },
        { assignmentType: "all" },
      ];
      if (user.departmentId) {
        orConditions.push({ assignmentType: "department", targetId: user.departmentId });
      }

      const schedules = await prisma.shiftSchedule.findMany({
        where: {
          companyId: user.companyId,
          OR:        orConditions,
          startDate: { lte: dayStart },
          endDate:   { gte: dayStart },
          isActive:  true,
        },
        include: { shift: true },
      });

      const PRIORITY = { individual: 0, department: 1, all: 2 };
      schedules.sort((a, b) => (PRIORITY[a.assignmentType] ?? 99) - (PRIORITY[b.assignmentType] ?? 99));

      const matched = schedules.find((s) =>
        Array.isArray(s.daysOfWeek) && s.daysOfWeek.includes(dayOfWeek)
      );

      if (matched?.shift) {
        userShifts.push({
          id:              matched.id,
          shift:           matched.shift,
          assignedDate:    dayStart,
          customStartTime: null,
          customEndTime:   null,
        });
      }
    }
  }

  return matchShiftToWindow(userShifts, timeIn, timeOut, tz);
}

// ── Segment boundary resolver ─────────────────────────────────────────────────

/**
 * Resolves the scheduled segment time windows for a batch of DRIVER_AIDE time
 * logs. Used by syncApprovalRecords to populate segmentStart / segmentEnd on
 * TimeLogApproval rows.
 *
 * Fetches catalog shifts once per company and batches the UserShift lookup
 * across all logs so the caller does not need N round-trips.
 *
 * @param {Array<{ id: string, timeIn: Date|string, userId: string }>} driverLogs
 * @param {string} companyId
 * @returns {Promise<Record<string, { driver_am, regular, driver_pm }>>}
 *   Map of timeLogId → segment boundaries ({ start: Date, end: Date } | null)
 */
async function resolveDriverAideSegments(driverLogs, companyId) {
  if (driverLogs.length === 0) return {};

  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { timeZone: true },
  });
  const tz = resolveTimezone(company?.timeZone);

  // Catalog shifts — single fetch for the whole batch
  const catalogShifts = await prisma.shift.findMany({
    where: {
      companyId,
      shiftName: { in: ["Regular Shift", "Driver/Aide AM Shift", "Driver/Aide PM Shift"] },
    },
    select: { shiftName: true, startTime: true, endTime: true },
  });
  const catalogShiftMap = Object.fromEntries(catalogShifts.map((s) => [s.shiftName, s]));

  // Determine date range then batch-fetch all relevant UserShifts
  const dates     = driverLogs.map((l) => new Date(l.timeIn).getTime());
  const rangeStart = moment(new Date(Math.min(...dates))).tz(tz).startOf("day").toDate();
  const rangeEnd   = moment(new Date(Math.max(...dates))).tz(tz).endOf("day").toDate();
  const userIds    = [...new Set(driverLogs.map((l) => l.userId))];

  const allUserShifts = await prisma.userShift.findMany({
    where: {
      userId:       { in: userIds },
      assignedDate: { gte: rangeStart, lte: rangeEnd },
      status:       { not: "cancelled" },
    },
    include: { shift: true },
  });

  // Group by `${userId}_${YYYY-MM-DD}` for O(1) lookup per log.
  // assignedDate is @db.Date stored as midnight UTC — use the UTC date string directly
  // rather than converting through the company timezone, which would shift the date
  // back by one day for companies west of UTC (e.g. America/Los_Angeles).
  const shiftsByUserDate = {};
  for (const us of allUserShifts) {
    const key = `${us.userId}_${new Date(us.assignedDate).toISOString().slice(0, 10)}`;
    if (!shiftsByUserDate[key]) shiftsByUserDate[key] = [];
    shiftsByUserDate[key].push(us);
  }

  const result = {};
  for (const log of driverLogs) {
    const timeIn     = new Date(log.timeIn);
    const dateStr    = moment(timeIn).tz(tz).format("YYYY-MM-DD");
    const userShifts = shiftsByUserDate[`${log.userId}_${dateStr}`] ?? [];

    const resolve = (name) => {
      const assigned = userShifts.find((us) => us.shift?.shiftName === name);
      const source   = assigned?.shift ?? catalogShiftMap[name] ?? null;
      if (!source?.startTime || !source?.endTime) return null;
      return {
        start: combineDateWithTimeTz(timeIn, source.startTime, tz),
        end:   combineDateWithTimeTz(timeIn, source.endTime,   tz),
      };
    };

    result[log.id] = {
      driver_am: resolve("Driver/Aide AM Shift"),
      regular:   resolve("Regular Shift"),
      driver_pm: resolve("Driver/Aide PM Shift"),
    };
  }

  return result;
}

module.exports = { computeTimeLogSummary, resolveShiftForTimeLog, resolveDriverAideSegments };
