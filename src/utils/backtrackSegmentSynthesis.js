// src/utils/backtrackSegmentSynthesis.js
// Pure, DB-free math for BB-086: turns a day's aggregate CSV hour totals
// (regular / driver_am / driver_pm) into synthetic TimeLog {timeIn, timeOut}
// records that, once approved via "Approve Raw" on the Cutoff Period page,
// credit back the same per-segment hour totals.
//
// GROUNDING (verified against src/services/timeLogComputeService.js and
// src/services/Cutoff/daycareCutoffStrategy.js): a single timeIn/timeOut pair
// clamped against a segment window can only vary the segment that is FIRST
// (controlled by timeIn) or LAST (controlled by timeOut) in chronological
// order — any segment in between is always credited its full scheduled
// window, regardless of the raw punch. DRIVER_SEGMENT_MAP (punchTypeUtils.js)
// says DRIVER_AIDE covers all three (driver_am, regular, driver_pm) in one
// record, which makes "regular" an uncontrollable middle segment whenever
// both AM and PM are present.
//
// That's only a problem when the CSV's regular value actually differs from
// the full scheduled "Regular Shift" window by more than the company's own
// grace period. Approve Raw already snaps a slightly-late/short FIRST
// segment back up to full credit when it's within grace (see the
// creditedIn/graceMs logic mirrored in predictSegmentCreditedHours below) —
// so a shortfall inside the grace window would get rounded back up to the
// full amount even with a two-punch split, making the split pointless for
// that case. So: when regularHours is within [fullWindow - grace,
// fullWindow] (an ordinary day, or a shortfall grace already forgives), this
// emits a SINGLE DRIVER_AIDE record — one punch, all three segments,
// matching the normal single-punch shape. Only when the shortfall genuinely
// exceeds grace (a real partial/short day) — or regularHours exceeds the
// window entirely — does it fall back to TWO records: DRIVER_AIDE_AM
// (driver_am first, regular last, forced to 0) then DRIVER_AIDE_PM (regular
// first, driver_pm last) — so that day's actual value can still be recorded
// exactly instead of silently getting rounded up to the full window.

const { DRIVER_SEGMENT_MAP, lastDriverSegment } = require("./punchTypeUtils");

const HOUR_MS = 3600000;

function hasHours(value) {
  return typeof value === "number" && value > 0;
}

// First-segment hours are hard-capped at the window's own duration (a
// non-last segment can never exceed segEnd - segStart). Returns
// { timeAnchor, achievedHours, capped, maxAchievableHours }.
function solveFirstSegment(requestedHours, window) {
  const maxAchievableHours = +((window.end.getTime() - window.start.getTime()) / HOUR_MS).toFixed(2);
  const capped = requestedHours > maxAchievableHours + 0.005;
  const achievedHours = capped ? maxAchievableHours : requestedHours;
  const timeAnchor = capped
    ? window.start
    : new Date(window.end.getTime() - achievedHours * HOUR_MS);
  return { timeAnchor, achievedHours, capped, maxAchievableHours };
}

// Last-segment hours are open-ended — excess flows into OT at approval time,
// so there's no cap to enforce here.
function solveLastSegment(requestedHours, window) {
  return new Date(window.start.getTime() + requestedHours * HOUR_MS);
}

/**
 * Replicates the exact raw-mode crediting formula from
 * daycareCutoffStrategy.js (approveSingle/approveBulk, Driver/Aide branch) so
 * the preview can show a "predicted hours after Approve Raw" figure per
 * segment instead of just trusting the synthesis.
 */
function predictSegmentCreditedHours({ recordTimeIn, recordTimeOut, segmentType, punchType, window, graceMinutes }) {
  if (!window) return null;
  const graceMs = (graceMinutes * 60 + 59) * 1000;
  const isLast = segmentType === lastDriverSegment(punchType);

  let creditedIn = Math.max(recordTimeIn.getTime(), window.start.getTime());
  const lateMs = recordTimeIn.getTime() - window.start.getTime();
  if (lateMs > 0 && lateMs <= graceMs) creditedIn = window.start.getTime();

  const approvedOut = isLast ? recordTimeOut.getTime() : window.end.getTime();
  return +(Math.max(0, approvedOut - creditedIn) / HOUR_MS).toFixed(2);
}

function buildSegmentReport({ target, punchType, segmentType, recordTimeIn, recordTimeOut, window, graceMinutes, capped, maxAchievableHours }) {
  if (target == null) return null;
  return {
    target,
    predicted: predictSegmentCreditedHours({ recordTimeIn, recordTimeOut, segmentType, punchType, window, graceMinutes }),
    capped: !!capped,
    ...(capped && { maxAchievableHours }),
  };
}

/**
 * @param {object} params
 * @param {number|null} params.regularHours
 * @param {number|null} params.amHours
 * @param {number|null} params.pmHours
 * @param {{start:Date,end:Date}|null} params.regularWindow
 * @param {{start:Date,end:Date}|null} params.amWindow
 * @param {{start:Date,end:Date}|null} params.pmWindow
 * @param {number} params.graceMinutes
 * @returns {{ records: Array<{punchType, timeIn, timeOut, segments}>, error: string|null }}
 */
function synthesizeDaySegments({ regularHours, amHours, pmHours, regularWindow, amWindow, pmWindow, graceMinutes }) {
  const hasReg = hasHours(regularHours);
  const hasAm = hasHours(amHours);
  const hasPm = hasHours(pmHours);

  if (!hasReg && !hasAm && !hasPm) {
    return { records: [], error: null };
  }

  const missing = [];
  if (hasAm && !amWindow) missing.push('"Driver/Aide AM Shift"');
  if (hasPm && !pmWindow) missing.push('"Driver/Aide PM Shift"');
  if ((hasAm || hasPm) && !regularWindow) missing.push('"Regular Shift"');
  if (missing.length > 0) {
    return {
      records: [],
      error: `Cannot synthesize times — ${missing.join(" and ")} not configured for this company/employee on this date.`,
    };
  }

  const records = [];

  if (hasAm && hasPm) {
    const fullRegularWindowHours = +((regularWindow.end.getTime() - regularWindow.start.getTime()) / HOUR_MS).toFixed(2);
    // Same grace formula predictSegmentCreditedHours (and daycareCutoffStrategy's
    // raw-mode approval) uses — a shortfall within it gets grace-snapped back
    // up to full credit regardless, so there's nothing to gain by splitting.
    const graceHours = ((graceMinutes * 60 + 59) * 1000) / HOUR_MS;
    const shortfallHours = hasReg ? fullRegularWindowHours - regularHours : Infinity;
    const regularMatchesFullWindow = hasReg && shortfallHours >= -0.005 && shortfallHours <= graceHours;

    if (regularMatchesFullWindow) {
      // Ordinary day — regular already equals the full scheduled window, so
      // a single DRIVER_AIDE punch (driver_am first, regular forced-but-
      // correct in the middle, driver_pm last) reproduces the CSV exactly.
      const am = solveFirstSegment(amHours, amWindow);
      const timeIn = am.timeAnchor;
      const timeOut = solveLastSegment(pmHours, pmWindow);
      records.push({
        punchType: "DRIVER_AIDE",
        timeIn,
        timeOut,
        segments: {
          driverAm: buildSegmentReport({ target: amHours, punchType: "DRIVER_AIDE", segmentType: "driver_am", recordTimeIn: timeIn, recordTimeOut: timeOut, window: amWindow, graceMinutes, capped: am.capped, maxAchievableHours: am.maxAchievableHours }),
          regular: buildSegmentReport({ target: regularHours, punchType: "DRIVER_AIDE", segmentType: "regular", recordTimeIn: timeIn, recordTimeOut: timeOut, window: regularWindow, graceMinutes, capped: false }),
          driverPm: buildSegmentReport({ target: pmHours, punchType: "DRIVER_AIDE", segmentType: "driver_pm", recordTimeIn: timeIn, recordTimeOut: timeOut, window: pmWindow, graceMinutes, capped: false }),
        },
      });
      return { records, error: null };
    }

    // Exceptional partial/short regular day — a single punch would force
    // "regular" to the full window and silently misreport this specific
    // day's actual value, so split into two records instead so it can still
    // be captured exactly.
    // Record A: DRIVER_AIDE_AM — driver_am (first) + regular (last, forced to 0).
    const am = solveFirstSegment(amHours, amWindow);
    const recA = { timeIn: am.timeAnchor, timeOut: regularWindow.start };
    records.push({
      punchType: "DRIVER_AIDE_AM",
      timeIn: recA.timeIn,
      timeOut: recA.timeOut,
      segments: {
        driverAm: buildSegmentReport({ target: amHours, punchType: "DRIVER_AIDE_AM", segmentType: "driver_am", recordTimeIn: recA.timeIn, recordTimeOut: recA.timeOut, window: amWindow, graceMinutes, capped: am.capped, maxAchievableHours: am.maxAchievableHours }),
        regular: buildSegmentReport({ target: 0, punchType: "DRIVER_AIDE_AM", segmentType: "regular", recordTimeIn: recA.timeIn, recordTimeOut: recA.timeOut, window: regularWindow, graceMinutes, capped: false }),
      },
    });

    // Record B: DRIVER_AIDE_PM — regular (first, carries the day's full regularHours) + driver_pm (last).
    const reg = solveFirstSegment(hasReg ? regularHours : 0, regularWindow);
    const recB = { timeIn: reg.timeAnchor, timeOut: solveLastSegment(pmHours, pmWindow) };
    records.push({
      punchType: "DRIVER_AIDE_PM",
      timeIn: recB.timeIn,
      timeOut: recB.timeOut,
      segments: {
        regular: buildSegmentReport({ target: hasReg ? regularHours : 0, punchType: "DRIVER_AIDE_PM", segmentType: "regular", recordTimeIn: recB.timeIn, recordTimeOut: recB.timeOut, window: regularWindow, graceMinutes, capped: reg.capped, maxAchievableHours: reg.maxAchievableHours }),
        driverPm: buildSegmentReport({ target: pmHours, punchType: "DRIVER_AIDE_PM", segmentType: "driver_pm", recordTimeIn: recB.timeIn, recordTimeOut: recB.timeOut, window: pmWindow, graceMinutes, capped: false }),
      },
    });
    return { records, error: null };
  }

  if (hasAm) {
    // AM present, PM absent — single DRIVER_AIDE_AM record. driver_am first,
    // regular last (controllable — full requested value, never capped: it's
    // the record's last segment).
    const am = solveFirstSegment(amHours, amWindow);
    const timeOut = hasReg ? solveLastSegment(regularHours, regularWindow) : regularWindow.start;
    records.push({
      punchType: "DRIVER_AIDE_AM",
      timeIn: am.timeAnchor,
      timeOut,
      segments: {
        driverAm: buildSegmentReport({ target: amHours, punchType: "DRIVER_AIDE_AM", segmentType: "driver_am", recordTimeIn: am.timeAnchor, recordTimeOut: timeOut, window: amWindow, graceMinutes, capped: am.capped, maxAchievableHours: am.maxAchievableHours }),
        regular: buildSegmentReport({ target: hasReg ? regularHours : 0, punchType: "DRIVER_AIDE_AM", segmentType: "regular", recordTimeIn: am.timeAnchor, recordTimeOut: timeOut, window: regularWindow, graceMinutes, capped: false }),
      },
    });
    return { records, error: null };
  }

  if (hasPm) {
    // PM present, AM absent — single DRIVER_AIDE_PM record. regular first
    // (controllable, capped at its own window), driver_pm last.
    const reg = solveFirstSegment(hasReg ? regularHours : 0, regularWindow);
    const timeOut = solveLastSegment(pmHours, pmWindow);
    records.push({
      punchType: "DRIVER_AIDE_PM",
      timeIn: reg.timeAnchor,
      timeOut,
      segments: {
        regular: buildSegmentReport({ target: hasReg ? regularHours : 0, punchType: "DRIVER_AIDE_PM", segmentType: "regular", recordTimeIn: reg.timeAnchor, recordTimeOut: timeOut, window: regularWindow, graceMinutes, capped: reg.capped, maxAchievableHours: reg.maxAchievableHours }),
        driverPm: buildSegmentReport({ target: pmHours, punchType: "DRIVER_AIDE_PM", segmentType: "driver_pm", recordTimeIn: reg.timeAnchor, recordTimeOut: timeOut, window: pmWindow, graceMinutes, capped: false }),
      },
    });
    return { records, error: null };
  }

  // Regular hours only — plain REGULAR punch, no Driver/Aide segment math at
  // all. createTimeLogFromRequest sets autoLunchDeductionMinutes: 0, so
  // computeTimeLogSummary won't deduct a lunch break here, and (per
  // daycareCutoffStrategy's REGULAR/raw branch) an employee with no assigned
  // shift for this historical date gets no grace-snap either — netWorkedHours
  // and Approve Raw's actualHours both come out to exactly timeOut - timeIn.
  const anchor = regularWindow ? regularWindow.start : null;
  if (!anchor) {
    return { records: [], error: 'Cannot synthesize times — "Regular Shift" not configured for this company.' };
  }
  const timeOut = new Date(anchor.getTime() + regularHours * HOUR_MS);
  records.push({
    punchType: "REGULAR",
    timeIn: anchor,
    timeOut,
    segments: {
      regular: { target: regularHours, predicted: regularHours, capped: false },
    },
  });
  return { records, error: null };
}

module.exports = { synthesizeDaySegments, DRIVER_SEGMENT_MAP };
