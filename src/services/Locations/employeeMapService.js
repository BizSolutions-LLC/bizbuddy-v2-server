// src/services/Locations/employeeMapService.js
//
// BB-128 (part 1): Employee Map — where employees clock in and clock out.
// Read-only. Uses the location the web/mobile app already saves on each punch:
//   TimeLog.location = { start: { latitude, longitude, accuracy?, ... } | null,
//                        end:   { ... } | null }
// No schema change. GPS breadcrumbs (tracking during the shift) will be added
// as another layer once the mobile developer is back; the response is shaped
// for that (`layers`).
//
// Scope: admin/superadmin → whole company; supervisor → their department +
// direct reports; anyone else → 403.
// Dates: one day by default, or a from/to range (max 31 days), in the company
// time zone. A clock-in counts on the day of its timeIn, a clock-out on the
// day of its timeOut.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const DEFAULT_TZ = "America/Los_Angeles";
const MANAGER_ROLES = ["admin", "superadmin"];
const TYPES = ["in", "out", "both"];
const MAX_RANGE_DAYS = 31;
const BIN_DECIMALS = 4; // ~11 m grid for the heat layer

class EmployeeMapError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const zoneOf = (tz) => (tz && moment.tz.zone(tz) ? tz : DEFAULT_TZ);

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || "Unknown";
};

function parseDay(value, tz, field) {
  const m = moment.tz(String(value), "YYYY-MM-DD", true, tz);
  if (!m.isValid()) throw new EmployeeMapError(400, `${field} must be YYYY-MM-DD.`);
  return m.format("YYYY-MM-DD");
}

function parseFilters(query, tz) {
  let from;
  let to;
  if (query.from || query.to) {
    from = parseDay(query.from || query.to, tz, "from");
    to = parseDay(query.to || query.from, tz, "to");
  } else {
    from = to = query.date ? parseDay(query.date, tz, "date") : moment.tz(tz).format("YYYY-MM-DD");
  }
  if (from > to) throw new EmployeeMapError(400, "from must be on or before to.");
  if (moment(to).diff(moment(from), "days") + 1 > MAX_RANGE_DAYS)
    throw new EmployeeMapError(400, `The range can be at most ${MAX_RANGE_DAYS} days.`);

  const type = String(query.type || "both").toLowerCase();
  if (!TYPES.includes(type)) throw new EmployeeMapError(400, "type must be in, out or both.");

  return {
    from,
    to,
    type,
    start: moment.tz(from, "YYYY-MM-DD", tz).startOf("day").toDate(),
    end: moment.tz(to, "YYYY-MM-DD", tz).endOf("day").toDate(),
    departmentId: query.departmentId ? String(query.departmentId) : null,
    userId: query.userId ? String(query.userId) : null,
  };
}

/** Prisma `where` on User for the people this actor may see. */
async function scopeWhere(actor) {
  if (MANAGER_ROLES.includes(actor.role)) return { companyId: actor.companyId };
  if (actor.role === "supervisor") {
    // req.user has no departmentId — load it.
    const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { departmentId: true } });
    return {
      companyId: actor.companyId,
      OR: [{ employmentDetail: { supervisorId: actor.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])],
    };
  }
  throw new EmployeeMapError(403, "Only supervisors and admins can view the Employee Map.");
}

/** { lat, lng, accuracy } from a saved punch location, or null if unusable. */
function readCoords(loc) {
  if (!loc || typeof loc !== "object") return null;
  const lat = Number(loc.latitude ?? loc.lat);
  const lng = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null; // "null island": a failed fix, not a place
  const acc = Number(loc.accuracy);
  return { lat, lng, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Nearest work site and whether the point is inside its radius. */
function matchSite(sites, lat, lng) {
  let best = null;
  for (const s of sites) {
    const d = distanceMeters(lat, lng, s.latitude, s.longitude);
    if (!best || d < best.distance) best = { site: s, distance: d };
  }
  if (!best) return { siteId: null, siteName: null, distanceMeters: null, insideSite: null };
  return {
    siteId: best.site.id,
    siteName: best.site.name,
    distanceMeters: Math.round(best.distance),
    insideSite: best.site.radius != null ? best.distance <= best.site.radius : null,
  };
}

/** Groups points on a ~11 m grid: [{ lat, lng, weight }], heaviest first. */
function toHeat(points) {
  const bins = new Map();
  for (const p of points) {
    const lat = Number(p.lat.toFixed(BIN_DECIMALS));
    const lng = Number(p.lng.toFixed(BIN_DECIMALS));
    const key = `${lat},${lng}`;
    const bin = bins.get(key) || { lat, lng, weight: 0 };
    bin.weight += 1;
    bins.set(key, bin);
  }
  return [...bins.values()].sort((a, b) => b.weight - a.weight);
}

async function buildEmployeeMap(actor, query = {}) {
  const company = await prisma.company.findUnique({ where: { id: actor.companyId }, select: { id: true, name: true, timeZone: true } });
  if (!company) throw new EmployeeMapError(404, "Company not found.");
  const tz = zoneOf(company.timeZone);
  const f = parseFilters(query, tz);
  const userScope = await scopeWhere(actor);

  const wantIn = f.type !== "out";
  const wantOut = f.type !== "in";
  const range = { gte: f.start, lte: f.end };

  const [logs, siteRows] = await Promise.all([
    prisma.timeLog.findMany({
      where: {
        OR: [...(wantIn ? [{ timeIn: range }] : []), ...(wantOut ? [{ timeOut: range }] : [])],
        user: {
          ...HUMAN_ONLY,
          ...userScope,
          ...(f.departmentId && { departmentId: f.departmentId }),
          ...(f.userId && { id: f.userId }),
        },
      },
      select: {
        id: true, timeIn: true, timeOut: true, punchType: true, location: true,
        user: {
          select: {
            id: true, email: true, employeeId: true,
            profile: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { timeIn: "asc" },
    }),
    prisma.location.findMany({
      where: { companyId: actor.companyId },
      select: { id: true, name: true, latitude: true, longitude: true, radius: true },
    }),
  ]);

  const sites = siteRows.map((s) => ({
    id: s.id,
    name: s.name,
    latitude: Number(s.latitude),
    longitude: Number(s.longitude),
    radius: s.radius != null ? Number(s.radius) : null,
  }));

  const layers = { clockIn: [], clockOut: [] };
  const missing = { clockIn: 0, clockOut: 0 };
  const employees = new Map();

  const addPunch = (log, kind, at, loc) => {
    const emp = log.user;
    if (!employees.has(emp.id)) {
      employees.set(emp.id, {
        id: emp.id,
        name: personName(emp),
        employeeId: emp.employeeId ?? null,
        department: emp.department?.name ?? null,
        clockIns: 0,
        clockOuts: 0,
        withoutLocation: 0,
      });
    }
    const e = employees.get(emp.id);
    if (kind === "in") e.clockIns += 1;
    else e.clockOuts += 1;

    const c = readCoords(loc);
    if (!c) {
      missing[kind === "in" ? "clockIn" : "clockOut"] += 1;
      e.withoutLocation += 1;
      return;
    }
    layers[kind === "in" ? "clockIn" : "clockOut"].push({
      timeLogId: log.id,
      type: kind,
      at,
      atLocal: moment.tz(at, tz).format("YYYY-MM-DD h:mm A"),
      punchType: log.punchType,
      employeeId: emp.id,
      employeeName: e.name,
      department: e.department,
      lat: c.lat,
      lng: c.lng,
      accuracy: c.accuracy,
      ...matchSite(sites, c.lat, c.lng),
    });
  };

  for (const log of logs) {
    if (wantIn && log.timeIn >= f.start && log.timeIn <= f.end) addPunch(log, "in", log.timeIn, log.location?.start);
    if (wantOut && log.timeOut && log.timeOut >= f.start && log.timeOut <= f.end) addPunch(log, "out", log.timeOut, log.location?.end);
  }

  const allPoints = [...layers.clockIn, ...layers.clockOut];
  const countLayer = (pts, miss) => ({
    punches: pts.length + miss,
    withLocation: pts.length,
    withoutLocation: miss,
    outsideSites: sites.length ? pts.filter((p) => p.insideSite === false).length : null,
  });

  return {
    company: { id: company.id, name: company.name, timeZone: tz },
    filters: { from: f.from, to: f.to, type: f.type, departmentId: f.departmentId, userId: f.userId },
    sites,
    summary: {
      clockIn: wantIn ? countLayer(layers.clockIn, missing.clockIn) : null,
      clockOut: wantOut ? countLayer(layers.clockOut, missing.clockOut) : null,
      employees: employees.size,
    },
    heat: toHeat(allPoints),
    layers: {
      clockIn: wantIn ? layers.clockIn : [],
      clockOut: wantOut ? layers.clockOut : [],
      breadcrumbs: null, // BB-128 part 2 — needs the mobile app; not collected yet
    },
    employees: [...employees.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

module.exports = { buildEmployeeMap, EmployeeMapError };
