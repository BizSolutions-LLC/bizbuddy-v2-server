const MAX_SAMPLES = 50;
const FUTURE_SKEW_MS = 2 * 60 * 1000;

function checkBatchShape(body) {
  const samples = body && body.samples;
  if (!Array.isArray(samples) || samples.length < 1) {
    return { error: { status: 400, message: "samples must contain 1 to 50 items.", code: "INVALID_SAMPLES" } };
  }
  if (samples.length > MAX_SAMPLES) {
    return { error: { status: 400, message: "samples must contain 1 to 50 items.", code: "TOO_MANY_SAMPLES" } };
  }
  return { samples };
}

function coordinateError(sample) {
  const lat = Number(sample && sample.latitude);
  const lng = Number(sample && sample.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Coordinates must be numbers.";
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return "Coordinates are out of range.";
  if (lat === 0 && lng === 0) return "Coordinates are unusable.";
  return null;
}

function classifySample(sample, log, now) {
  if (!sample || typeof sample.timeLogId !== "string" || sample.timeLogId.length > 64) {
    return { status: "rejected", reason: "Punch not found." };
  }
  if (!log) return { status: "rejected", reason: "Punch not found." };
  const coords = coordinateError(sample);
  if (coords) return { status: "rejected", reason: coords };
  if (typeof sample.recordedAt !== "string") {
    return { status: "rejected", reason: "recordedAt must be an ISO timestamp." };
  }
  const recordedMs = Date.parse(sample.recordedAt);
  if (!Number.isFinite(recordedMs)) {
    return { status: "rejected", reason: "recordedAt must be an ISO timestamp." };
  }
  if (recordedMs > now.getTime() + FUTURE_SKEW_MS) {
    return { status: "rejected", reason: "recordedAt is in the future." };
  }
  if (recordedMs < new Date(log.timeIn).getTime()) {
    return { status: "rejected", reason: "recordedAt is before clock-in." };
  }
  if (log.timeOut && recordedMs > new Date(log.timeOut).getTime()) {
    return { status: "rejected", reason: "recordedAt is after clock-out." };
  }
  return { status: "ok", recordedAt: new Date(recordedMs) };
}

// Battery is stored as a fraction 0–1. Apps send either 0–1 (iOS, Expo) or a
// percent 0–100 (Android). A value above 1 is read as a percent; exactly 1 = full.
// Anything else (missing, negative, over 100, not a number) is stored as null.
function cleanBatteryLevel(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  const fraction = n > 1 ? n / 100 : n;
  return Math.round(fraction * 1000) / 1000;
}

// "locate" = one fix taken because the admin asked for it on the Live map (BB-128 phase 3b).
function cleanSource(value) {
  if (value === "foreground" || value === "background" || value === "locate") return value;
  return null;
}

module.exports = {
  MAX_SAMPLES,
  checkBatchShape,
  coordinateError,
  classifySample,
  cleanSource,
  cleanBatteryLevel,
};
