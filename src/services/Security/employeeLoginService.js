// src/services/Security/employeeLoginService.js
//
// BB-137: Company panel → Requests & Logs → Employee Logins (admins only, B. Buddy
// included). Read-only views over LoginEvent:
//   - listLogins:      every attempt in a date range, with flags and a summary
//   - employeeLogins:  one employee's timeline, devices, and punches from a device
//                      that isn't theirs (needs BB-134 punch proof on)
//   - sharedDevices:   devices / browsers that signed in to 2+ accounts
// B. Buddy (support) sign-ins are never listed. Other companies' people are never
// named: only counted ("also used by 1 account in another company").

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const MAX_RANGE_DAYS = 92;
const FAILED = { not: "success" };

class EmployeeLoginError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function companyZone(companyId) {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { timeZone: true } });
  return c?.timeZone || "America/Los_Angeles";
}

/** from/to are company-zone dates (YYYY-MM-DD). */
function range(q, tz, defaultDays) {
  const today = moment.tz(tz).format("YYYY-MM-DD");
  const to = q.to || today;
  const from = q.from || moment.tz(to, "YYYY-MM-DD", tz).subtract(defaultDays - 1, "days").format("YYYY-MM-DD");
  const a = moment.tz(from, "YYYY-MM-DD", true, tz);
  const b = moment.tz(to, "YYYY-MM-DD", true, tz);
  if (!a.isValid() || !b.isValid()) throw new EmployeeLoginError(400, "from and to must be dates (YYYY-MM-DD).");
  if (a.isAfter(b)) throw new EmployeeLoginError(400, "from must be on or before to.");
  if (b.diff(a, "days") > MAX_RANGE_DAYS) throw new EmployeeLoginError(400, `Pick at most ${MAX_RANGE_DAYS} days.`);
  return { from, to, start: a.startOf("day").toDate(), end: b.endOf("day").toDate() };
}

const nameOf = (u) =>
  u ? `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() || u.email : null;

const userSelect = {
  id: true, email: true, companyId: true, status: true,
  profile: { select: { firstName: true, lastName: true } },
  department: { select: { id: true, name: true } },
};

/** sharedWith ids → same-company people (named) + other-company count. */
async function resolveShared(companyId, idLists) {
  const ids = [...new Set(idLists.flat().filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: userSelect });
  return new Map(users.map((u) => [u.id, u]));
}

function sharedView(companyId, ids, usersById) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const same = [];
  let otherCompanies = 0;
  for (const id of ids) {
    const u = usersById.get(id);
    if (u && u.companyId === companyId) same.push({ userId: u.id, name: nameOf(u) });
    else otherCompanies += 1;
  }
  return { sameCompany: same, otherCompanyAccounts: otherCompanies };
}

function shapeEvent(e, tz, companyId, usersById) {
  return {
    id: e.id,
    at: e.createdAt,
    atLocal: moment.tz(e.createdAt, tz).format("YYYY-MM-DD h:mm:ss A"),
    event: e.event,
    outcome: e.outcome,
    failed: e.outcome !== "success",
    employee: e.user ? { id: e.user.id, name: nameOf(e.user), department: e.user.department?.name ?? null, status: e.user.status } : null,
    email: e.email,
    platform: e.platform,
    deviceId: e.deviceId,
    browserId: e.browserId,
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    flags: {
      platformSwitch: e.platformSwitch,
      newDevice: e.newDevice,
      sharedDevice: e.sharedDevice,
      failedBurst: e.failedBurst,
    },
    sharedWith: e.sharedDevice ? sharedView(companyId, e.sharedWith, usersById) : null,
    source: e.source,
  };
}

const FLAG_FIELDS = ["platformSwitch", "newDevice", "sharedDevice", "failedBurst"];

/**
 * GET /api/employee-logins?from&to&userId&departmentId&platform&outcome&flag&q&page&pageSize
 *   outcome: success | failed | <exact outcome>; flag: any | platformSwitch | newDevice | sharedDevice | failedBurst
 */
async function listLogins(actor, q = {}) {
  const tz = await companyZone(actor.companyId);
  const r = range(q, tz, 7);
  const where = { companyId: actor.companyId, isSystemAgent: false, createdAt: { gte: r.start, lte: r.end } };
  if (q.userId) where.userId = String(q.userId);
  if (q.departmentId) where.user = { departmentId: String(q.departmentId) };
  if (q.platform) where.platform = String(q.platform);
  if (q.event) where.event = String(q.event);
  if (q.outcome === "failed") where.outcome = FAILED;
  else if (q.outcome) where.outcome = String(q.outcome);
  if (q.flag === "any") where.OR = FLAG_FIELDS.map((f) => ({ [f]: true }));
  else if (FLAG_FIELDS.includes(q.flag)) where[q.flag] = true;
  if (q.q) {
    const s = String(q.q).trim().slice(0, 100);
    if (s) {
      const or = [
        { email: { contains: s, mode: "insensitive" } },
        { ipAddress: { contains: s } },
        { deviceId: { contains: s } },
        { browserId: { contains: s } },
      ];
      where.AND = [...(where.AND || []), { OR: or }];
    }
  }

  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 50, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);

  const baseWhere = { companyId: actor.companyId, isSystemAgent: false, createdAt: { gte: r.start, lte: r.end } };
  const [rows, total, byOutcome, byPlatform, flagCounts] = await Promise.all([
    prisma.loginEvent.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
      include: { user: { select: userSelect } },
    }),
    prisma.loginEvent.count({ where }),
    prisma.loginEvent.groupBy({ by: ["outcome"], where: { ...baseWhere, event: "sign_in" }, _count: { _all: true } }),
    prisma.loginEvent.groupBy({ by: ["platform"], where: { ...baseWhere, event: "sign_in", outcome: "success" }, _count: { _all: true } }),
    Promise.all(FLAG_FIELDS.map((f) => prisma.loginEvent.count({ where: { ...baseWhere, [f]: true } }))),
  ]);

  const usersById = await resolveShared(actor.companyId, rows.map((e) => (Array.isArray(e.sharedWith) ? e.sharedWith : [])));
  const signIns = byOutcome.reduce((n, b) => n + b._count._all, 0);
  const successes = byOutcome.find((b) => b.outcome === "success")?._count._all || 0;

  return {
    timeZone: tz,
    filters: { from: r.from, to: r.to, userId: q.userId || null, departmentId: q.departmentId || null, platform: q.platform || null, outcome: q.outcome || null, flag: q.flag || null, q: q.q || null },
    summary: {
      signIns,
      successful: successes,
      failed: signIns - successes,
      byOutcome: byOutcome.map((b) => ({ outcome: b.outcome, count: b._count._all })).sort((a, b) => b.count - a.count),
      byPlatform: byPlatform.map((b) => ({ platform: b.platform, count: b._count._all })),
      flagged: Object.fromEntries(FLAG_FIELDS.map((f, i) => [f, flagCounts[i]])),
    },
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    total,
    items: rows.map((e) => shapeEvent(e, tz, actor.companyId, usersById)),
  };
}

/** GET /api/employee-logins/employees/:userId?from&to — timeline, devices, foreign-device punches. */
async function employeeLogins(actor, userId, q = {}) {
  const user = await prisma.user.findFirst({
    where: { id: String(userId), companyId: actor.companyId, ...HUMAN_ONLY },
    select: { ...userSelect, registeredDeviceId: true, registeredDeviceAt: true, lastLoginAt: true },
  });
  if (!user) throw new EmployeeLoginError(404, "Employee not found.");
  const tz = await companyZone(actor.companyId);
  const r = range(q, tz, 30);

  const events = await prisma.loginEvent.findMany({
    where: { userId: user.id, createdAt: { gte: r.start, lte: r.end } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  // Devices / browsers this employee signed in from (all of the kept year).
  const allSuccess = await prisma.loginEvent.findMany({
    where: { userId: user.id, event: "sign_in", outcome: "success" },
    select: { platform: true, deviceId: true, browserId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const devices = new Map();
  for (const e of allSuccess) {
    const key = e.deviceId ? `device:${e.deviceId}` : e.browserId ? `browser:${e.browserId}` : `unknown:${e.platform}`;
    const d = devices.get(key) || { kind: e.deviceId ? "device" : e.browserId ? "browser" : "unknown", id: e.deviceId || e.browserId || null, platform: e.platform, firstSeen: e.createdAt, lastSeen: e.createdAt, signIns: 0 };
    d.lastSeen = e.createdAt;
    d.signIns += 1;
    devices.set(key, d);
  }
  const deviceList = [...devices.values()];
  const keyed = deviceList.filter((d) => d.id);
  const otherUse = keyed.length
    ? await prisma.loginEvent.findMany({
        where: {
          outcome: "success", isSystemAgent: false, userId: { not: null, notIn: [user.id] },
          OR: keyed.map((d) => (d.kind === "device" ? { deviceId: d.id } : { browserId: d.id })),
        },
        distinct: ["userId", "deviceId", "browserId"],
        select: { userId: true, deviceId: true, browserId: true },
      })
    : [];
  const usersById = await resolveShared(actor.companyId, [
    otherUse.map((o) => o.userId),
    events.map((e) => (Array.isArray(e.sharedWith) ? e.sharedWith : [])).flat(),
  ]);
  for (const d of deviceList) {
    const ids = otherUse.filter((o) => (d.kind === "device" ? o.deviceId === d.id : o.browserId === d.id)).map((o) => o.userId);
    d.alsoUsedBy = sharedView(actor.companyId, [...new Set(ids)], usersById);
    d.isRegisteredPhone = d.kind === "device" && d.id === user.registeredDeviceId;
  }

  // Punches in the range from a device that isn't this employee's (BB-134 proof).
  const logs = await prisma.timeLog.findMany({
    where: { userId: user.id, timeIn: { gte: r.start, lte: r.end } },
    select: { id: true, timeIn: true, timeOut: true, deviceInfo: true },
    orderBy: { timeIn: "desc" },
  });
  const proofDeviceIds = new Set();
  for (const l of logs) for (const side of ["start", "end"]) {
    const id = l.deviceInfo?.[side]?.proof?.deviceId;
    if (id) proofDeviceIds.add(id);
  }
  const ownerRows = proofDeviceIds.size
    ? await prisma.loginEvent.findMany({
        where: { deviceId: { in: [...proofDeviceIds] }, outcome: "success", isSystemAgent: false, userId: { not: null } },
        distinct: ["deviceId", "userId"],
        select: { deviceId: true, userId: true },
      })
    : [];
  const ownersByDevice = new Map();
  for (const o of ownerRows) ownersByDevice.set(o.deviceId, [...(ownersByDevice.get(o.deviceId) || []), o.userId]);
  const ownerUsers = await resolveShared(actor.companyId, [ownerRows.map((o) => o.userId)]);

  const foreignPunches = [];
  for (const l of logs) {
    for (const [side, at] of [["start", l.timeIn], ["end", l.timeOut]]) {
      const proof = l.deviceInfo?.[side]?.proof;
      if (!proof || !at) continue;
      const others = (ownersByDevice.get(proof.deviceId) || []).filter((id) => id !== user.id);
      if (proof.deviceMatch === false || others.length) {
        foreignPunches.push({
          timeLogId: l.id,
          punch: side === "start" ? "clock-in" : "clock-out",
          at,
          atLocal: moment.tz(at, tz).format("YYYY-MM-DD h:mm A"),
          deviceId: proof.deviceId || null,
          registeredDeviceId: proof.registeredDeviceId ?? null,
          deviceMatch: proof.deviceMatch ?? null,
          deviceAlsoUsedBy: sharedView(actor.companyId, others, ownerUsers),
        });
      }
    }
  }

  return {
    timeZone: tz,
    filters: { from: r.from, to: r.to },
    employee: {
      id: user.id, name: nameOf(user), email: user.email, department: user.department?.name ?? null, status: user.status,
      registeredDeviceId: user.registeredDeviceId, registeredDeviceAt: user.registeredDeviceAt, lastLoginAt: user.lastLoginAt,
    },
    summary: {
      signIns: events.filter((e) => e.event === "sign_in").length,
      failed: events.filter((e) => e.event === "sign_in" && e.outcome !== "success").length,
      flagged: Object.fromEntries(FLAG_FIELDS.map((f) => [f, events.filter((e) => e[f]).length])),
      devices: deviceList.length,
      foreignDevicePunches: foreignPunches.length,
    },
    devices: deviceList.sort((a, b) => b.lastSeen - a.lastSeen),
    events: events.map((e) => shapeEvent({ ...e, user: null }, tz, actor.companyId, usersById)),
    foreignDevicePunches: foreignPunches,
    punchProofNote: "Punch device checks need the company's 'Record punch device' setting (BB-134) on; punches before it was on have no device.",
  };
}

/** GET /api/employee-logins/shared-devices?from&to — devices / browsers used by 2+ accounts of this company. */
async function sharedDevices(actor, q = {}) {
  const tz = await companyZone(actor.companyId);
  const r = range({ ...q, from: q.from, to: q.to }, tz, 90);
  const rows = await prisma.loginEvent.findMany({
    where: {
      companyId: actor.companyId, isSystemAgent: false, event: "sign_in", outcome: "success",
      userId: { not: null }, createdAt: { gte: r.start, lte: r.end },
      OR: [{ deviceId: { not: null } }, { browserId: { not: null } }],
    },
    select: { userId: true, deviceId: true, browserId: true, platform: true, createdAt: true },
  });

  const groups = new Map();
  for (const e of rows) {
    const key = e.deviceId ? `device:${e.deviceId}` : `browser:${e.browserId}`;
    const g = groups.get(key) || { kind: e.deviceId ? "device" : "browser", id: e.deviceId || e.browserId, platform: e.platform, users: new Map(), lastSeen: e.createdAt };
    const u = g.users.get(e.userId) || { userId: e.userId, signIns: 0, lastSeen: e.createdAt };
    u.signIns += 1;
    if (e.createdAt > u.lastSeen) u.lastSeen = e.createdAt;
    if (e.createdAt > g.lastSeen) g.lastSeen = e.createdAt;
    g.users.set(e.userId, u);
    groups.set(key, g);
  }
  const shared = [...groups.values()].filter((g) => g.users.size >= 2);
  const usersById = await resolveShared(actor.companyId, shared.map((g) => [...g.users.keys()]));

  return {
    timeZone: tz,
    filters: { from: r.from, to: r.to },
    items: shared
      .map((g) => ({
        kind: g.kind,
        id: g.id,
        platform: g.platform,
        lastSeen: g.lastSeen,
        accounts: [...g.users.values()]
          .map((u) => ({ ...u, name: nameOf(usersById.get(u.userId)), department: usersById.get(u.userId)?.department?.name ?? null }))
          .sort((a, b) => b.signIns - a.signIns),
      }))
      .sort((a, b) => b.accounts.length - a.accounts.length || b.lastSeen - a.lastSeen),
  };
}

module.exports = { listLogins, employeeLogins, sharedDevices, EmployeeLoginError };
