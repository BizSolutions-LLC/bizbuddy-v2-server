// src/services/timeLogComputeUtils.js
// Pure, sync helpers shared by all timeLog compute strategies.
// No DB calls. No side effects. Safe to require from any strategy.

const moment = require("moment-timezone");

function timeStrFromDbTime(timeLikeDate) {
  const t = new Date(timeLikeDate);
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const ss = String(t.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function resolveTimezone(companyTz) {
  if (companyTz && moment.tz.zone(companyTz)) return companyTz;
  return "America/Los_Angeles";
}

/**
 * Calendar YYYY-MM-DD from a @db.Date (stored as midnight UTC).
 * Do not timezone-shift — that would move e.g. Monday to Sunday in US zones.
 */
function dateKeyFromDbDate(date) {
  return moment.utc(date).format("YYYY-MM-DD");
}

/** Today’s calendar date in an IANA timezone (for timestamps like `now`). */
function dateKeyInTz(date, tz) {
  return moment(date).tz(tz).format("YYYY-MM-DD");
}

/**
 * Combines a @db.Date assignedDate with a @db.Time start/end, in the given timezone.
 */
function combineAssignedDateWithTimeTz(assignedDate, timeLikeDate, tz) {
  const dateOnly = dateKeyFromDbDate(assignedDate);
  const timeStr = timeStrFromDbTime(timeLikeDate);
  return moment
    .tz(`${dateOnly} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", tz)
    .toDate();
}

function combineDateWithTimeTz(referenceDate, timeLikeDate, tz) {
  const dateOnly = moment(referenceDate).tz(tz).format("YYYY-MM-DD");
  const timeStr  = timeStrFromDbTime(timeLikeDate);
  return moment.tz(`${dateOnly} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", tz).toDate();
}

/** 30-minute clock-in reminder window (pure; used by clockInReminderWorker). */
function evaluateClockInReminder({ assignedDate, startTime, tz, now }) {
  if (dateKeyFromDbDate(assignedDate) !== dateKeyInTz(now, tz)) {
    return { shouldRemind: false };
  }
  const shiftStart = combineAssignedDateWithTimeTz(assignedDate, startTime, tz);
  const minutesToStart = (shiftStart.getTime() - now.getTime()) / 60000;
  if (minutesToStart <= 0) return { shouldRemind: false };
  if (minutesToStart <= 30 && minutesToStart > 29) {
    return {
      shouldRemind: true,
      shiftStart,
      minutesRemaining: Math.round(minutesToStart),
    };
  }
  return { shouldRemind: false };
}

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

function lunchBreakMinutes(lunchBreak) {
  if (!lunchBreak?.start || !lunchBreak?.end) return 0;
  const diffMs = new Date(lunchBreak.end) - new Date(lunchBreak.start);
  return diffMs > 0 ? diffMs / 60000 : 0;
}

function computeSegmentHours(timeIn, timeOut, segStart, segEnd) {
  if (!segStart || !segEnd) return null;
  const start = Math.max(timeIn.getTime(),  segStart.getTime());
  const end   = Math.min(timeOut.getTime(), segEnd.getTime());
  return +(Math.max(0, end - start) / 3600000).toFixed(2);
}

// BB-092 — Driver/Aide lunch is deducted from whichever segment window it falls
// in. Returns the ms of a completed, deductible lunch that overlaps
// [windowStart, windowEnd]. Auto-injected non-deductible lunches return 0
// (paper trail only), same rule as sumCoffeeBreakMinutes.
function lunchOverlapMs(lunchBreak, windowStart, windowEnd) {
  if (!lunchBreak?.start || !lunchBreak?.end || !windowStart || !windowEnd) return 0;
  if (lunchBreak.auto && lunchBreak.deductible === false) return 0;
  const start = Math.max(new Date(lunchBreak.start).getTime(), new Date(windowStart).getTime());
  const end   = Math.min(new Date(lunchBreak.end).getTime(),   new Date(windowEnd).getTime());
  return Math.max(0, end - start);
}

function matchShiftToWindow(userShifts, timeIn, timeOut, tz) {
  if (userShifts.length === 0) return null;
  if (userShifts.length === 1) return userShifts[0];

  const timeInMs  = timeIn.getTime();
  const timeOutMs = timeOut.getTime();

  const prevDay = moment(timeIn).tz(tz).subtract(1, "day").toDate();
  const anchors = [timeIn, prevDay];

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

  const best = windows.reduce((a, b) => b.overlap > a.overlap ? b : a);
  if (best.overlap > 0) return best.us;

  return windows.reduce((a, b) => b.closestDist < a.closestDist ? b : a).us;
}

module.exports = {
  timeStrFromDbTime,
  resolveTimezone,
  dateKeyFromDbDate,
  dateKeyInTz,
  combineAssignedDateWithTimeTz,
  combineDateWithTimeTz,
  evaluateClockInReminder,
  sumCoffeeBreakMinutes,
  lunchBreakMinutes,
  computeSegmentHours,
  lunchOverlapMs,
  matchShiftToWindow,
};
