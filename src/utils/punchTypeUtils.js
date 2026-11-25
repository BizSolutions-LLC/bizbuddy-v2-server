// src/utils/punchTypeUtils.js

const VALID_PUNCH_TYPES = [
  "REGULAR",
  "DRIVER_AIDE",
  "DRIVER_AIDE_AM",
  "DRIVER_AIDE_PM",
  "TRAINING",
];

/** Maps client "reason" labels to PunchType enum values (case-insensitive). */
function punchTypeFromReason(reason) {
  if (typeof reason !== "string") return null;
  if (reason.trim().toLowerCase() === "training") return "TRAINING";
  return null;
}

/**
 * Resolves punch type: explicit punchType wins, then reason mapping, else REGULAR.
 */
function resolvePunchType({ punchType, reason } = {}) {
  if (punchType && VALID_PUNCH_TYPES.includes(punchType)) return punchType;
  const fromReason = punchTypeFromReason(reason);
  if (fromReason) return fromReason;
  return "REGULAR";
}

/**
 * Which TimeLogApproval segmentType rows a Driver/Aide punch type produces, in
 * chronological order. DRIVER_AIDE is the full AM+Regular+PM day; DRIVER_AIDE_AM/PM
 * are single-route days that still include the Regular program segment alongside
 * the one route (matches computeTimeLogSummary's netWorkedHours composition — see
 * timeLogComputeService.js, isDriverAm/isDriverPm). Non-Driver punch types (REGULAR,
 * TRAINING) are absent from this map and get a single segmentType:null approval row.
 */
const DRIVER_SEGMENT_MAP = {
  DRIVER_AIDE:    ["driver_am", "regular", "driver_pm"],
  DRIVER_AIDE_AM: ["driver_am", "regular"],
  DRIVER_AIDE_PM: ["regular", "driver_pm"],
};

function isDriverSegmentPunchType(punchType) {
  return Object.prototype.hasOwnProperty.call(DRIVER_SEGMENT_MAP, punchType);
}

/** The chronologically-last segment for a Driver/Aide punch type, or null otherwise. */
function lastDriverSegment(punchType) {
  const segs = DRIVER_SEGMENT_MAP[punchType];
  return segs ? segs[segs.length - 1] : null;
}

/**
 * DayCare training punches (BB-149): write the real net hours to the TimeLog —
 * clock span minus coffee breaks and lunch deduction, no shift snap, no cap.
 * Was a flat company.defaultShiftHours (8h) whatever the punch length.
 * scheduledHours = the same hours (training has no schedule to compare against).
 * Returns the updated TimeLog; an open punch (no clock-out) is returned unchanged.
 */
async function applyTrainingHours(timeLogId, companyId) {
  const { prisma } = require("@config/connection");
  const { computeTrainingHours } = require("@services/timeLogComputeService");
  const [log, company] = await Promise.all([
    prisma.timeLog.findUnique({ where: { id: timeLogId } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { minimumLunchMinutes: true } }),
  ]);
  const hours = computeTrainingHours(log, company);
  if (!hours) return log;
  return prisma.timeLog.update({
    where: { id: timeLogId },
    data: {
      ...hours,
      scheduledHours: hours.netWorkedHours,
      calculatedAt:   new Date(),
    },
  });
}

module.exports = {
  VALID_PUNCH_TYPES,
  punchTypeFromReason,
  resolvePunchType,
  applyTrainingHours,
  DRIVER_SEGMENT_MAP,
  isDriverSegmentPunchType,
  lastDriverSegment,
};
