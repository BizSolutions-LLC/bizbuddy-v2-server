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
// Phase 3b ("Locate now": silent push → fresh point) is not built. When it is,
// the fresh point lands in LocationBreadcrumb like any other, so this response
// picks it up unchanged.

const moment = require("moment-timezone");
const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { personName, markerOf } = require("@services/Locations/mapPeople");
const { EmployeeMapError, MANAGER_ROLES, zoneOf, readCoords, loadSites } = require("@services/Locations/employeeMapService");

const REFRESH_SECONDS = 60;
const STALE_FACTOR = 3;
const MAX_OPEN_HOURS = 24;

const fmtLocal = (at, tz) => moment.tz(at, tz).format("YYYY-MM-DD h:mm A");

/** Latest breadcrumb per punch, one row each (uses the (timeLogId, recordedAt) index). */
async function latestPoints(timeLogIds) {
  if (!timeLogIds.length) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON ("timeLogId")
           "timeLogId", "recordedAt", latitude, longitude, accuracy, speed, heading,
           "batteryLevel", "isMocked", source
    FROM "LocationBreadcrumb"
    WHERE "timeLogId" IN (${Prisma.join(timeLogIds)})
    ORDER BY "timeLogId", "recordedAt" DESC`;
  return new Map(rows.map((r) => [r.timeLogId, r]));
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
    latestPoints(ids),
    ids.length
      ? prisma.liveUser.findMany({ where: { timeLogId: { in: ids } }, select: { timeLogId: true, closeAt: true } })
      : [],
  ]);
  const closeAtBy = new Map(liveRows.map((r) => [r.timeLogId, r.closeAt]));

  const summary = { clockedIn: open.length, live: 0, stale: 0, clockInOnly: 0, noPosition: 0 };

  const employees = open.map((log) => {
    const u = log.user;
    const crumb = points.get(log.id);
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
      };
      summary[stale ? "stale" : "live"] += 1;
    } else {
      const pin = readCoords(log.location?.start);
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
    },
    filters: { departmentId },
    sites,
    summary,
    employees,
  };
}

module.exports = { buildLiveMap, REFRESH_SECONDS };
