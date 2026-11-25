// src/services/Locations/breadcrumbService.js
//
// BB-128 part 2: GPS breadcrumbs, the employee's location during the shift.
//
// Upload is the mobile developer's endpoint: POST /api/timelogs/location-breadcrumbs
// (services/Locations/locationBreadcrumbService.js + locationBreadcrumbRules.js).
// The app reads Company.breadcrumbsEnabled / breadcrumbIntervalMinutes from
// /api/company-settings and collectUntil from time-in / GET /timelogs/user.
// This file keeps the parts that endpoint doesn't cover:
//   - the Employee Map layer (layers.breadcrumbs, one track per punch);
//   - RETENTION_DAYS for the nightly cleanup (jobs/breadcrumbRetentionJob.js).
// isMocked (fake GPS reported by the phone) is shown flagged, never hidden.
// Impossible travel (BB-128, 2026-11-20): the phone can hide a fake location, so
// the server also checks speed. Two consecutive points (or a clock-in/out pin and
// the nearest route point) that imply more than MAX_MPH over more than
// MIN_JUMP_METERS are flagged "suspicious": kept and shown, left out of the
// distance, never rejected (same policy as isMocked).
// Low accuracy (2026-11-25): a point whose accuracy radius is over
// LOW_ACCURACY_METERS is still shown (lowAccuracy: true) and still checked for
// impossible travel, but the distance only adds legs between accurate points,
// so GPS drift doesn't inflate it. Points with no accuracy count as accurate.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { markerOf } = require("@services/Locations/mapPeople");

const RETENTION_DAYS = 90;
const MAX_LAYER_POINTS = 50000;
const GAP_FACTOR = 3; // a gap = no point for 3 × the interval
const MAX_MPH = 120; // faster than any road trip
const MIN_JUMP_METERS = 1000; // ignore GPS jitter between nearby points
const MPS_PER_MPH = 0.44704;
const LOW_ACCURACY_METERS = 100;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Movement between two located moments → { meters, seconds, mph, kmh, suspicious }. */
function travel(aLat, aLng, aAt, bLat, bLng, bAt) {
  const meters = distanceMeters(aLat, aLng, bLat, bLng);
  const seconds = Math.max(0, (new Date(bAt) - new Date(aAt)) / 1000);
  const mps = seconds > 0 ? meters / seconds : meters > 0 ? Infinity : 0;
  const suspicious = meters > MIN_JUMP_METERS && mps > MAX_MPH * MPS_PER_MPH;
  const round = (v) => (Number.isFinite(v) ? Math.round(v) : null); // null = same instant
  return { meters: Math.round(meters), seconds: Math.round(seconds), mph: round(mps / MPS_PER_MPH), kmh: round(mps * 3.6), suspicious };
}

const pinOf = (loc) => {
  const lat = Number(loc?.latitude);
  const lng = Number(loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  const acc = Number(loc?.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
};

/** Punch pin for tracks[].pins (same atLocal format as the /punches layer). */
const pinOut = (pin, at, tz) =>
  pin ? { lat: pin.lat, lng: pin.lng, at, atLocal: moment.tz(at, tz).format("YYYY-MM-DD h:mm A"), accuracy: pin.accuracy } : null;

/**
 * Breadcrumb layer for the Employee Map: one track per punch.
 * @param {object} userWhere  Prisma `where` on User (scope + filters, HUMAN_ONLY included)
 */
async function buildBreadcrumbLayer({ companyId, userWhere, start, end, tz, intervalMinutes }) {
  const rows = await prisma.locationBreadcrumb.findMany({
    where: { companyId, recordedAt: { gte: start, lte: end }, user: userWhere },
    select: {
      timeLogId: true, recordedAt: true, latitude: true, longitude: true, accuracy: true,
      speed: true, batteryLevel: true, isMocked: true,
      user: {
        select: {
          id: true, email: true,
          profile: { select: { firstName: true, lastName: true } },
          department: { select: { name: true } },
        },
      },
    },
    orderBy: [{ timeLogId: "asc" }, { recordedAt: "asc" }],
    take: MAX_LAYER_POINTS + 1,
  });

  const truncated = rows.length > MAX_LAYER_POINTS;
  if (truncated) rows.length = MAX_LAYER_POINTS;

  const gapMs = GAP_FACTOR * (intervalMinutes || 5) * 60 * 1000;
  const tracks = new Map();
  for (const r of rows) {
    let t = tracks.get(r.timeLogId);
    if (!t) {
      const name = `${r.user?.profile?.firstName || ""} ${r.user?.profile?.lastName || ""}`.trim() || r.user?.email || "Unknown";
      t = {
        timeLogId: r.timeLogId,
        employeeId: r.user.id,
        employeeName: name,
        ...markerOf(r.user), // initials + color, same as the other map views
        department: r.user.department?.name ?? null,
        startedAt: r.recordedAt,
        endedAt: r.recordedAt,
        pointCount: 0,
        mockedPoints: 0,
        lowAccuracyPoints: 0,
        distanceMeters: 0,
        gaps: [],
        jumps: [], // impossible travel between two route points
        pins: { clockIn: null, clockOut: null }, // the punch's clock-in / clock-out pins (null = no location or still open)
        pinChecks: { clockIn: null, clockOut: null }, // punch pin vs first/last route point
        suspicious: 0, // jumps + pin mismatches
        points: [],
        _last: null, // last non-mocked point, for impossible travel
        _lastAccurate: null, // last non-mocked accurate point, for distance
        _prevAt: null,
      };
      tracks.set(r.timeLogId, t);
    }
    if (t._prevAt && r.recordedAt - t._prevAt > gapMs) {
      t.gaps.push({ from: t._prevAt, to: r.recordedAt, minutes: Math.round((r.recordedAt - t._prevAt) / 60000) });
    }
    t._prevAt = r.recordedAt;
    t.endedAt = r.recordedAt;
    t.pointCount += 1;
    let jumped = false;
    const lowAccuracy = r.accuracy != null && r.accuracy > LOW_ACCURACY_METERS;
    if (r.isMocked) t.mockedPoints += 1;
    else {
      if (t._last) {
        const mv = travel(t._last.latitude, t._last.longitude, t._last.recordedAt, r.latitude, r.longitude, r.recordedAt);
        if (mv.suspicious) {
          jumped = true;
          t.jumps.push({
            from: { at: t._last.recordedAt, lat: t._last.latitude, lng: t._last.longitude },
            to: { at: r.recordedAt, lat: r.latitude, lng: r.longitude },
            meters: mv.meters, seconds: mv.seconds, mph: mv.mph, kmh: mv.kmh,
          });
        }
      }
      if (lowAccuracy) t.lowAccuracyPoints += 1;
      if (jumped) {
        // Impossible travel: the leg never counts; restart the distance from here.
        t._lastAccurate = lowAccuracy ? null : r;
      } else if (!lowAccuracy) {
        if (t._lastAccurate) {
          t.distanceMeters += distanceMeters(t._lastAccurate.latitude, t._lastAccurate.longitude, r.latitude, r.longitude);
        }
        t._lastAccurate = r;
      }
      t._first = t._first || r;
      t._last = r;
    }
    t.points.push({
      at: r.recordedAt,
      atLocal: moment.tz(r.recordedAt, tz).format("YYYY-MM-DD h:mm A"),
      lat: r.latitude,
      lng: r.longitude,
      accuracy: r.accuracy != null ? Math.round(r.accuracy) : null,
      speed: r.speed,
      batteryLevel: r.batteryLevel,
      isMocked: r.isMocked,
      lowAccuracy, // accuracy radius > LOW_ACCURACY_METERS: shown, not counted in distance
      jumpedHere: jumped, // true = arrived here by impossible travel (draw the segment before it as suspicious)
    });
  }

  // Punch pins (tracks[].pins, 2026-11-25 client request) and pins vs the route:
  // clock-in pin → first real point, last real point → clock-out pin.
  if (tracks.size) {
    const logs = await prisma.timeLog.findMany({
      where: { id: { in: [...tracks.keys()] } },
      select: { id: true, timeIn: true, timeOut: true, location: true },
    });
    for (const log of logs) {
      const t = tracks.get(log.id);
      if (!t) continue;
      const inPin = pinOf(log.location?.start);
      const outPin = log.timeOut ? pinOf(log.location?.end) : null;
      t.pins = { clockIn: pinOut(inPin, log.timeIn, tz), clockOut: pinOut(outPin, log.timeOut, tz) };
      if (!t._first) continue; // every point fake GPS: nothing to compare
      if (inPin) {
        const mv = travel(inPin.lat, inPin.lng, log.timeIn, t._first.latitude, t._first.longitude, t._first.recordedAt);
        t.pinChecks.clockIn = { meters: mv.meters, seconds: mv.seconds, mph: mv.mph, kmh: mv.kmh, suspicious: mv.suspicious };
      }
      if (outPin) {
        const mv = travel(t._last.latitude, t._last.longitude, t._last.recordedAt, outPin.lat, outPin.lng, log.timeOut);
        t.pinChecks.clockOut = { meters: mv.meters, seconds: mv.seconds, mph: mv.mph, kmh: mv.kmh, suspicious: mv.suspicious };
      }
    }
  }

  const list = [...tracks.values()].map(({ _last, _first, _prevAt, _lastAccurate, ...t }) => ({
    ...t,
    distanceMeters: Math.round(t.distanceMeters),
    suspicious: t.jumps.length + (t.pinChecks.clockIn?.suspicious ? 1 : 0) + (t.pinChecks.clockOut?.suspicious ? 1 : 0),
  }));
  list.sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.startedAt - b.startedAt);

  return {
    tracks: list,
    summary: {
      tracks: list.length,
      points: rows.length,
      mockedPoints: list.reduce((n, t) => n + t.mockedPoints, 0),
      lowAccuracyPoints: list.reduce((n, t) => n + t.lowAccuracyPoints, 0),
      suspiciousTracks: list.filter((t) => t.suspicious > 0).length,
      truncated,
    },
  };
}

module.exports = {
  buildBreadcrumbLayer,
  RETENTION_DAYS,
  LOW_ACCURACY_METERS,
};
