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

/** DayCare training punches: flat credit from company.defaultShiftHours. */
async function applyTrainingFlatHours(timeLogId, companyId) {
  const { prisma } = require("@config/connection");
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { defaultShiftHours: true },
  });
  const trainingHours = parseFloat((company?.defaultShiftHours ?? 8).toString());
  return prisma.timeLog.update({
    where: { id: timeLogId },
    data: { netWorkedHours: trainingHours, scheduledHours: trainingHours },
  });
}

module.exports = {
  VALID_PUNCH_TYPES,
  punchTypeFromReason,
  resolvePunchType,
  applyTrainingFlatHours,
  DRIVER_SEGMENT_MAP,
  isDriverSegmentPunchType,
  lastDriverSegment,
};
