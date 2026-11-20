// src/services/TimeLogs/punchDisplay.js
//
// BB-126: ONE place for the per-punch values shown to people, used by BOTH
//   - the punch-log report (services/Reports/punchLogReportService.js), and
//   - the Employees Punch Logs table (GET /api/timelogs → row.display),
// so the table and the PDF / Excel can't disagree again. Moved here unchanged
// from punchLogReportService (BB-119), plus the BB-126 "decided" rule.
//
// Sources of a punch's values (`basis`):
//   - "live":     the TimeLog's computed fields (timeLogComputeService).
//   - "decided":  BB-126 (user decision 2026-11-20) — once NONE of the punch's
//                 cutoff approvals is pending any more (every segment, for
//                 Driver/Aide), the decision is the answer even while the cutoff is
//                 still open: approved/resolved count their payable hours,
//                 excluded/rejected count 0 (as in payroll). Read fresh on every
//                 request, so a reset to pending goes straight back to live.
//   - "reviewed": the punch belongs to a selected cutoff that is locked/processed:
//                 payable hours of approved/resolved approvals only (excluded = 0),
//                 like the report's loadReviewed.
// Pure functions only: callers load the data.

const moment = require("moment-timezone");

const DA_TYPES = new Set(["DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"]);
const IN_PRIORITY = ["driver_am", "regular", "driver_pm", "__none__"];
const OUT_PRIORITY = ["driver_pm", "regular", "driver_am", "__none__"];

const num = (v) => (v == null ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const calYmd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
// A reviewed clock time counts as "adjusted" only when it differs from the punch by a minute or more.
const moved = (approved, raw) => !!approved && (!raw || Math.abs(new Date(approved) - new Date(raw)) >= 60000);

const breakMinutes = (b) => (b?.start && b?.end ? Math.max(0, (new Date(b.end) - new Date(b.start)) / 60000) : 0);
// totalBreakMinutes (includes auto breaks) wins; else the punched coffee breaks.
const coffeeMinutesOf = (tl) =>
  tl.totalBreakMinutes != null ? tl.totalBreakMinutes : (Array.isArray(tl.coffeeBreaks) ? tl.coffeeBreaks : []).reduce((t, b) => t + breakMinutes(b), 0);
// A stored deduction wins when no lunch was punched.
const lunchMinutesOf = (tl) =>
  !tl.lunchBreak?.start && (tl.lunchDeductionMinutes ?? 0) > 0 ? tl.lunchDeductionMinutes : breakMinutes(tl.lunchBreak);
// Lunch window: punched times, or "auto" when the lunch was deducted without a punch.
const lunchWindowOf = (tl) =>
  !tl.lunchBreak?.start && (tl.lunchDeductionMinutes ?? 0) > 0
    ? { lunchStart: null, lunchEnd: null, lunchAuto: true }
    : { lunchStart: tl.lunchBreak?.start || null, lunchEnd: tl.lunchBreak?.end || null, lunchAuto: false };
// Device "Brand, Model"; location "lat, lng".
const deviceText = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d;
  if (typeof d.value === "string") return d.value; // BB-134: string device info kept under `value` when proof is added
  return [d.manufacturer || d.brand, d.deviceName || d.model].filter(Boolean).join(", ") || null;
};
const locationText = (loc) =>
  loc && loc.latitude != null && loc.longitude != null ? `${Number(loc.latitude).toFixed(5)}, ${Number(loc.longitude).toFixed(5)}` : null;
// Device / location / lunch / gross details.
const detailOf = (tl) => ({
  gross: num(tl.grossHours),
  deviceIn: deviceText(tl.deviceInfo?.start),
  deviceOut: deviceText(tl.deviceInfo?.end),
  locationIn: locationText(tl.location?.start),
  locationOut: locationText(tl.location?.end),
  ...lunchWindowOf(tl),
});

// ── Approvals (same as timeLogController's dedupApprovalsBySegment / pickApprovedClockTime) ──
function dedupApprovalsBySegment(approvals) {
  const best = new Map();
  for (const a of approvals ?? []) {
    const key = a.segmentType ?? "__none__";
    const existing = best.get(key);
    if (!existing || (existing.status === "pending" && a.status !== "pending")) best.set(key, a);
  }
  return [...best.values()];
}
function pickApprovedClockTime(deduped, priority, field) {
  const bySeg = new Map(deduped.map((a) => [a.segmentType ?? "__none__", a]));
  for (const key of priority) {
    const a = bySeg.get(key);
    if (a && a.status === "approved" && a[field] != null) return a[field];
  }
  return null;
}
// Review state for the "Cutoff status" column.
function cutoffStatusOf(statuses) {
  if (!statuses.length) return "Not in a cutoff";
  if (statuses.some((s) => s === "pending")) return "Pending review";
  if (statuses.every((s) => s === "excluded" || s === "rejected")) return "Excluded";
  return "Approved";
}

// mirrors cutoffPeriodController.js:enrichApprovals — payable hours of one approval
// (segment-aware for Driver/Aide; approved actualHours wins; pending → stored value).
// `approval.timeLog` (or the `tl` argument) must carry the punch's hour fields.
function payableHoursOf(approval, tl = approval.timeLog) {
  const seg = approval.segmentType ?? null;
  const approvedActual = approval.status === "approved" && approval.actualHours != null ? Number(approval.actualHours) : null;
  if (tl.punchType === "DRIVER_AIDE" && seg) {
    const windowHours =
      approval.segmentStart && approval.segmentEnd ? (new Date(approval.segmentEnd) - new Date(approval.segmentStart)) / 3600000 : null;
    let approvedHours = approvedActual;
    if (approvedHours == null && approval.status === "approved" && approval.approvedClockIn && approval.approvedClockOut) {
      const segStart = approval.segmentStart ? new Date(approval.segmentStart).getTime() : -Infinity;
      if (new Date(approval.approvedClockIn).getTime() >= segStart) {
        approvedHours = (new Date(approval.approvedClockOut) - new Date(approval.approvedClockIn)) / 3600000;
      }
    }
    const stored = num(seg === "driver_am" ? tl.driverAmSegmentHours : seg === "regular" ? tl.regularSegmentHours : tl.driverPmSegmentHours);
    return { hours: approvedHours ?? stored ?? windowHours ?? 0, scheduled: windowHours ?? stored };
  }
  return { hours: approvedActual ?? num(tl.netWorkedHours) ?? num(tl.grossHours) ?? 0, scheduled: num(tl.scheduledHours) };
}

/** Payable hours from a punch's approvals; only approved/resolved count (excluded/rejected/pending = 0). */
function approvalHours(deduped, tl, { countResolved = true } = {}) {
  let worked = 0;
  let am = null;
  let reg = null;
  let pm = null;
  let scheduled = null;
  for (const a of deduped) {
    const { hours, scheduled: s } = payableHoursOf(a, tl);
    const counted = a.status === "approved" || (countResolved && a.status === "resolved");
    const payable = counted ? hours : 0;
    if (s != null) scheduled = (scheduled ?? 0) + s;
    if (a.segmentType === "driver_am") am = (am ?? 0) + payable;
    else if (a.segmentType === "regular") reg = (reg ?? 0) + payable;
    else if (a.segmentType === "driver_pm") pm = (pm ?? 0) + payable;
    else worked += payable;
  }
  const isSeg = am != null || reg != null || pm != null;
  return { worked: isSeg ? (am || 0) + (reg || 0) + (pm || 0) : worked, am, reg, pm, scheduled };
}

/** No approval of the punch is pending any more (all segments for Driver/Aide). */
const allDecided = (deduped) => deduped.length > 0 && deduped.every((a) => a.status && a.status !== "pending");

/**
 * The display values of ONE punch.
 * @param {object} tl  TimeLog with: id, userId, timeIn, timeOut, status, punchType, coffeeBreaks,
 *   lunchBreak, lunchDeductionMinutes, totalBreakMinutes, netWorkedHours, grossHours, scheduledHours,
 *   lateHours, undertimeHours, deviceInfo, location, rawOtMinutes, regular/driverAm/driverPmSegmentHours,
 *   overtime[{status, requestedHours}], approvals[{status, segmentType, actualHours, approvedClockIn,
 *   approvedClockOut, segmentStart, segmentEnd, cutoffPeriodId}]
 * @param {object} ctx { tz, isBnC, otBasis, blockByDay: Map("userId|YYYY-MM-DD" → {otHours,status}), reviewed: bool }
 */
function punchDisplay(tl, ctx) {
  const { tz, isBnC, otBasis, blockByDay = new Map(), reviewed = false } = ctx;
  const date = moment(tl.timeIn).tz(tz).format("YYYY-MM-DD");
  const deduped = dedupApprovalsBySegment(tl.approvals);
  const approvedIn = pickApprovedClockTime(deduped, IN_PRIORITY, "approvedClockIn");
  const approvedOut = pickApprovedClockTime(deduped, OUT_PRIORITY, "approvedClockOut");
  const isDA = DA_TYPES.has(tl.punchType);

  // ── hours by basis ──
  let basis = "live";
  let worked;
  let am = null;
  let reg = null;
  let pm = null;
  if (reviewed && deduped.length) {
    basis = "reviewed";
    ({ worked, am, reg, pm } = approvalHours(deduped, tl));
  } else if (allDecided(deduped)) {
    basis = "decided";
    ({ worked, am, reg, pm } = approvalHours(deduped, tl));
  } else {
    am = isDA && !isBnC ? num(tl.driverAmSegmentHours) : null;
    reg = isDA && !isBnC ? num(tl.regularSegmentHours) : null;
    pm = isDA && !isBnC ? num(tl.driverPmSegmentHours) : null;
    // DA total only when all three segments exist.
    const daTotal = isDA && am != null && reg != null && pm != null ? am + reg + pm : null;
    worked =
      tl.netWorkedHours != null ? (daTotal ?? Number(tl.netWorkedHours)) : tl.grossHours != null ? Number(tl.grossHours) : tl.timeOut ? (new Date(tl.timeOut) - new Date(tl.timeIn)) / 3600000 : 0;
  }

  // ── OT ──
  let otHours = 0;
  let otStatus = "—";
  const raw = (tl.rawOtMinutes || 0) / 60;
  if (isBnC) {
    const b = blockByDay.get(`${tl.userId}|${date}`);
    if (b) {
      otHours = Number(b.otHours);
      otStatus = cap(b.status);
    }
  } else if (otBasis === "cutoff") {
    otHours = null; // counted per cutoff, not per punch
  } else {
    const ots = Array.isArray(tl.overtime) ? tl.overtime : [];
    const approved = ots.filter((o) => o.status === "approved").reduce((t, o) => t + (Number(o.requestedHours) || 0), 0);
    const pending = ots.some((o) => o.status === "pending");
    if (basis === "reviewed") {
      otHours = approved; // reviewed: approved OT only
      otStatus = approved > 0 ? "Approved" : "—";
    } else {
      otHours = approved > 0 ? approved : raw;
      otStatus = approved > 0 ? "Approved" : pending ? "Pending" : raw > 0 ? "Not requested" : "—";
    }
  }

  return {
    userId: tl.userId,
    date,
    basis,
    clockIn: approvedIn || tl.timeIn,
    clockOut: approvedOut || tl.timeOut,
    clockAdjusted: moved(approvedIn, tl.timeIn) || moved(approvedOut, tl.timeOut),
    punchType: tl.punchType || "REGULAR",
    worked: r2(worked),
    am: r2(am),
    regular: r2(reg),
    pm: r2(pm),
    scheduled: r2(tl.scheduledHours),
    late: r2(tl.lateHours) ?? 0,
    undertime: r2(tl.undertimeHours) ?? 0,
    coffeeMinutes: Math.round(coffeeMinutesOf(tl)),
    lunchMinutes: Math.round(lunchMinutesOf(tl)),
    otHours: r2(otHours),
    otStatus,
    cutoffStatus: cutoffStatusOf(deduped.map((a) => a.status)),
    active: tl.status === true,
    isScheduled: tl.scheduledHours != null, // a shift was assigned that day
    ...detailOf(tl),
    gross: r2(tl.grossHours),
  };
}

module.exports = {
  DA_TYPES,
  IN_PRIORITY,
  OUT_PRIORITY,
  num,
  r2,
  cap,
  calYmd,
  moved,
  breakMinutes,
  coffeeMinutesOf,
  lunchMinutesOf,
  lunchWindowOf,
  deviceText,
  locationText,
  detailOf,
  dedupApprovalsBySegment,
  pickApprovedClockTime,
  cutoffStatusOf,
  payableHoursOf,
  approvalHours,
  allDecided,
  punchDisplay,
};
