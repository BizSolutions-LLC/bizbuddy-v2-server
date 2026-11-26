// src/services/Locations/liveMapService.js
//
// BB-128 map views (2026-11-25): the Live tab of the Employee Map.
// GET /api/employee-map/live → where each employee clocked in RIGHT NOW was last seen.
//
// Who: admins and superadmins only (the B. Buddy account signs in as admin, so it
// is included). Supervisors and employees get 404, as if the page didn't exist.
//
// Position per open punch: the latest GPS breadcrumb of that punch; if none has
// arrived yet, the clock-in pin; else null. "Stale" = older than
// STALE_FACTOR × the company's breadcrumb interval (same 3× rule the Routes tab
// uses for a gap).
//
// Privacy: only punches with no clock-out are listed, and only points inside
// that punch are ever read, so nobody is shown after clocking out. A punch left
// open for more than MAX_OPEN_HOURS is skipped (a forgotten punch, not someone
// at work).
//
// "Here since" (follow-up 2026-11-26, client request): position.hereSince = when the
// person arrived at the spot they are at now (Life360-style "here for 1 hr").
// Walk the punch's breadcrumbs back from the latest ACCURATE point and stop at the
// first one more than STAY_RADIUS_M away; hereSince = the time of the point just
// after it. Points less accurate than LOW_ACCURACY_METERS are skipped (one bad fix
// doesn't end the stay) and never used as the anchor. If the whole punch stayed
// within the radius: the clock-in time, unless the clock-in pin itself is
// farther than the radius (clocked in elsewhere), then the first breadcrumb.
// Clock-in pin only: the clock-in time. No accurate point: null.
//
// position.site (Live redesign, 2026-11-26, client request): work-site status
// { id, name, inside, distanceMeters (to the edge, 0 inside), since }, same walk-back.
//
// Phase 3b ("Locate now": silent push → fresh point) is not built. When it is,
// the fresh point lands in LocationBreadcrumb like any other, so this response
// picks it up unchanged.

const moment = require("moment-timezone");
const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { personName, markerOf } = require("@services/Locations/mapPeople");
const {
  EmployeeMapError, MANAGER_ROLES, zoneOf, readCoords, loadSites, distanceMeters, siteState,
} = require("@services/Locations/employeeMapService");
const { LOW_ACCURACY_METERS } = require("@services/Locations/breadcrumbService");
const { locateStatusFor, ANSWER_WINDOW_MS } = require("@services/Locations/locateRequestService");

const REFRESH_SECONDS = 60;
const STALE_FACTOR = 3;
const MAX_OPEN_HOURS = 24;
const STAY_RADIUS_M = 100; // same as the client's Routes stop radius (STOP_RADIUS_M)

const fmtLocal = (at, tz) => moment.tz(at, tz).format("YYYY-MM-DD h:mm A");

/**
 * Every breadcrumb of these punches, oldest first, grouped per punch
 * (uses the (timeLogId, recordedAt) unique index). The latest is the last item.
 */
async function punchPoints(timeLogIds) {
  if (!timeLogIds.length) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT "timeLogId", "recordedAt", latitude, longitude, accuracy, speed, heading,
           "batteryLevel", "isMocked", source
    FROM "LocationBreadcrumb"
    WHERE "timeLogId" IN (${Prisma.join(timeLogIds)})
    ORDER BY "timeLogId", "recordedAt" ASC`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.timeLogId)) out.set(r.timeLogId, []);
    out.get(r.timeLogId).push(r);
  }
  return out;
}

const isLowAccuracy = (p) => p.accuracy != null && p.accuracy > LOW_ACCURACY_METERS;

/** Index of the latest accurate breadcrumb, or -1. */
function anchorIndex(crumbs) {
  let i = crumbs.length - 1;
  while (i >= 0 && isLowAccuracy(crumbs[i])) i--;
  return i;
}

/**
 * Shared walk-back for hereSince and site.since: from the anchor (crumbs[i]) go back,
 * skipping low-accuracy points, until a point where `same(lat, lng)` is false; the
 * time of the point just after it. Whole punch the same: the clock-in time, unless
 * the clock-in pin (when usable) is not the same, then the first breadcrumb.
 */
function sinceSame(crumbs, i, same, clockInPin, timeIn) {
  let since = new Date(crumbs[i].recordedAt);
  for (let j = i - 1; j >= 0; j--) {
    const c = crumbs[j];
    if (isLowAccuracy(c)) continue;
    if (!same(c.latitude, c.longitude)) return since;
    since = new Date(c.recordedAt);
  }
  const pinUsable = clockInPin && !(clockInPin.accuracy != null && clockInPin.accuracy > LOW_ACCURACY_METERS);
  if (pinUsable && !same(clockInPin.lat, clockInPin.lng)) return since;
  return new Date(timeIn);
}

/** When the person arrived at the spot they are at now (see header). Date or null. */
function hereSinceFor(crumbs, clockInPin, timeIn) {
  const i = anchorIndex(crumbs);
  if (i < 0) return null;
  const a = crumbs[i];
  const near = (lat, lng) => distanceMeters(lat, lng, a.latitude, a.longitude) <= STAY_RADIUS_M;
  return sinceSame(crumbs, i, near, clockInPin, timeIn);
}

const siteKey = (st) => (st && st.inside ? `in:${st.site.id}` : "out");
const siteView = (st, since) =>
  st && {
    id: st.site.id,
    name: st.site.name,
    inside: st.inside,
    distanceMeters: st.inside ? 0 : Math.round(st.edgeMeters), // to the site's EDGE
    since,
  };

/**
 * position.site (Live redesign, 2026-11-26): the site they're inside, else the one
 * whose edge is nearest (siteState, same rule as /punches), and since when the
 * current state began. States: "inside site X" (each site its own state) or
 * "outside" (whatever site is nearest). Measured from the latest accurate point,
 * like hereSince; no accurate point → state from the latest point, since null.
 * null when no site has a radius or there's no position.
 */
function siteFor(sites, crumbs, clockInPin, timeIn) {
  if (!crumbs.length) {
    if (!clockInPin) return null;
    return siteView(siteState(sites, clockInPin.lat, clockInPin.lng), new Date(timeIn)) || null;
  }
  const i = anchorIndex(crumbs);
  if (i < 0) {
    const last = crumbs[crumbs.length - 1];
    return siteView(siteState(sites, last.latitude, last.longitude), null) || null;
  }
  const a = crumbs[i];
  const st = siteState(sites, a.latitude, a.longitude);
  if (!st) return null;
  const key = siteKey(st);
  const same = (lat, lng) => siteKey(siteState(sites, lat, lng)) === key;
  return siteView(st, sinceSame(crumbs, i, same, clockInPin, timeIn));
}

async function buildLiveMap(actor, query = {}) {
  if (!MANAGER_ROLES.includes(actor.role)) throw new EmployeeMapError(404, "Not found.");

  const company = await prisma.company.findUnique({
    where: { id: actor.companyId },
    select: { id: true, name: true, timeZone: true, breadcrumbsEnabled: true, breadcrumbIntervalMinutes: true },
  });
  if (!company) throw new EmployeeMapError(404, "Company not found.");
  const tz = zoneOf(company.timeZone);
  const departmentId = query.departmentId ? String(query.departmentId) : null;

  const now = new Date();
  const interval = company.breadcrumbIntervalMinutes || 5;
  const staleMs = STALE_FACTOR * interval * 60 * 1000;

  const [logs, sites] = await Promise.all([
    prisma.timeLog.findMany({
      where: {
        timeOut: null,
        timeIn: { gte: new Date(now.getTime() - MAX_OPEN_HOURS * 3600 * 1000), lte: now },
        user: { ...HUMAN_ONLY, companyId: actor.companyId, ...(departmentId && { departmentId }) },
      },
      select: {
        id: true, timeIn: true, punchType: true, location: true,
        user: {
          select: {
            id: true, email: true, employeeId: true,
            profile: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { timeIn: "desc" },
    }),
    loadSites(actor.companyId),
  ]);

  // One row per employee: their most recent open punch.
  const byUser = new Map();
  for (const log of logs) if (!byUser.has(log.user.id)) byUser.set(log.user.id, log);
  const open = [...byUser.values()];
  const ids = open.map((l) => l.id);

  const [points, liveRows] = await Promise.all([
    punchPoints(ids),
    ids.length
      ? prisma.liveUser.findMany({ where: { timeLogId: { in: ids } }, select: { timeLogId: true, closeAt: true } })
      : [],
  ]);
  const closeAtBy = new Map(liveRows.map((r) => [r.timeLogId, r.closeAt]));

  const summary = { clockedIn: open.length, live: 0, stale: 0, clockInOnly: 0, noPosition: 0 };

  const employees = open.map((log) => {
    const u = log.user;
    const crumbs = points.get(log.id) || [];
    const crumb = crumbs[crumbs.length - 1];
    const pin = readCoords(log.location?.start);
    let position = null;
    if (crumb) {
      const at = new Date(crumb.recordedAt);
      const stale = now - at > staleMs;
      position = {
        source: "breadcrumb",
        lat: crumb.latitude,
        lng: crumb.longitude,
        accuracy: crumb.accuracy != null ? Math.round(crumb.accuracy) : null,
        at,
        atLocal: fmtLocal(at, tz),
        ageSeconds: Math.max(0, Math.round((now - at) / 1000)),
        stale,
        speed: crumb.speed,
        heading: crumb.heading,
        batteryLevel: crumb.batteryLevel,
        isMocked: crumb.isMocked,
        appState: crumb.source, // foreground | background | null
        hereSince: hereSinceFor(crumbs, pin, log.timeIn),
        site: siteFor(sites, crumbs, pin, log.timeIn),
      };
      summary[stale ? "stale" : "live"] += 1;
    } else {
      if (pin) {
        position = {
          source: "clockIn",
          lat: pin.lat,
          lng: pin.lng,
          accuracy: pin.accuracy,
          at: log.timeIn,
          atLocal: fmtLocal(log.timeIn, tz),
          ageSeconds: Math.max(0, Math.round((now - log.timeIn) / 1000)),
          stale: true, // a clock-in pin is never a current position
          speed: null,
          heading: null,
          batteryLevel: null,
          isMocked: false,
          appState: null,
          hereSince: log.timeIn, // no breadcrumbs yet: here since clock-in
          site: siteFor(sites, [], pin, log.timeIn),
        };
        summary.clockInOnly += 1;
      } else summary.noPosition += 1;
    }
    const closeAt = closeAtBy.get(log.id) || null;
    return {
      employeeId: u.id,
      name: personName(u),
      ...markerOf(u),
      employeeCode: u.employeeId ?? null,
      department: u.department?.name ?? null,
      timeLogId: log.id,
      punchType: log.punchType,
      clockedInAt: log.timeIn,
      clockedInAtLocal: fmtLocal(log.timeIn, tz),
      collectUntil: closeAt ? closeAt.toISOString() : null,
      position,
      // BB-128 phase 3b: latest "Locate now" request for this punch (null = none in the last 10 min).
      locate: locateStatusFor(log.id, crumb ? crumb.recordedAt : null, now.getTime()),
    };
  });
  employees.sort((a, b) => a.name.localeCompare(b.name));

  return {
    company: { id: company.id, name: company.name, timeZone: tz },
    generatedAt: now,
    refreshSeconds: REFRESH_SECONDS,
    tracking: {
      enabled: company.breadcrumbsEnabled,
      intervalMinutes: interval,
      staleAfterMinutes: STALE_FACTOR * interval,
      locateAnswerSeconds: ANSWER_WINDOW_MS / 1000, // BB-128 phase 3b
    },
    filters: { departmentId },
    sites,
    summary,
    employees,
  };
}

module.exports = { buildLiveMap, REFRESH_SECONDS };
