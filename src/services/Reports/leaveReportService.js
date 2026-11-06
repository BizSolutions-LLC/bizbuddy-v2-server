// src/services/Reports/leaveReportService.js
//
// BB-098 — Leave reports (GET /api/reports/leave). Returns JSON only; the
// client builds the CSV / PDF / XLSX files. Five report types share one set of
// filters and one employee/policy scope:
//
//   summary     balances per employee × leave type as of `to`
//   activity    credited / used / adjusted / expired per employee × type × period
//   expiration  fiscal-year lots (LeaveCredit) and their expiry state
//   requests    leave requests overlapping the range
//   ledger      raw LeaveTransaction rows
//
// Ledger conventions (LeaveTransaction.hours is the signed balance change):
//   accrual      +  automatic grant                         → grantedHours
//   adjustment   ±  admin Adjust Credits (leaveId null)     → adjustedHours
//   adjustment   +  cutoff credit-back of a leave (leaveId) → nets usedHours
//   deduction    −  approved paid leave                     → usedHours
//   expired      −  lot expiration                          → expiredHours
// Every credit made before BB-098 setup is an admin adjustment, so
// `creditedHours` (= granted + positive admin adjustments) is reported too.
//
// Balances "as of" a date are anchored on today's real LeaveBalance and walk
// backwards through the ledger (balance − changes after the date). Balances
// from before the ledger existed have no rows, so summing forward from zero
// would be wrong.
//
// Dates are YYYY-MM-DD in the company timezone; *At fields are ISO UTC.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const {
  COMPANY_CREDIT_SELECT,
  fyLabel,
  fyStartStr,
  fiscalYearOf,
  dateColStr,
} = require("@services/Leave/leaveCreditService");

const REPORT_TYPES       = ["summary", "activity", "expiration", "requests", "ledger"];
const GROUP_BYS          = ["month", "quarter", "year"];
const BASES              = ["calendar", "fiscal"];
const REQUEST_STATUSES   = ["pending", "pending_secondary", "approved", "rejected", "cancelled"];
const BALANCE_TYPES      = ["accrual", "deduction", "adjustment", "expired"];
const MAX_RANGE_YEARS    = 5;
const DEFAULT_TZ         = "America/Los_Angeles";

const r2  = (n) => +Number(n || 0).toFixed(2);
const num = (v) => (v == null ? 0 : Number(v));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && moment.utc(s, "YYYY-MM-DD", true).isValid();
const parseList = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const parseBool = (v) => v === true || v === "true" || v === "1";

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

function parseFilters(query, company) {
  const type = query.type;
  if (!REPORT_TYPES.includes(type))
    throw new ReportError(400, `type must be one of: ${REPORT_TYPES.join(", ")}`);

  const tz = company.timeZone || DEFAULT_TZ;
  const today = moment.tz(tz).format("YYYY-MM-DD");

  const to = query.to || today;
  if (!isYmd(to)) throw new ReportError(400, "to must be YYYY-MM-DD");
  const from = query.from || null;
  if (from && !isYmd(from)) throw new ReportError(400, "from must be YYYY-MM-DD");
  if (!from && !["summary", "expiration"].includes(type))
    throw new ReportError(400, `from is required for type=${type}`);
  if (from && from > to) throw new ReportError(400, "from must not be after to");
  if (from && ["activity", "ledger"].includes(type) &&
      moment.utc(to).diff(moment.utc(from), "years", true) > MAX_RANGE_YEARS)
    throw new ReportError(400, `The range can't be longer than ${MAX_RANGE_YEARS} years for type=${type}`);

  const groupBy = query.groupBy || "month";
  if (!GROUP_BYS.includes(groupBy)) throw new ReportError(400, `groupBy must be one of: ${GROUP_BYS.join(", ")}`);
  const basis = query.basis || "fiscal";
  if (!BASES.includes(basis)) throw new ReportError(400, `basis must be one of: ${BASES.join(", ")}`);

  const status = query.status ? parseList(query.status) : ["approved"];
  const badStatus = status.filter((s) => !REQUEST_STATUSES.includes(s));
  if (badStatus.length)
    throw new ReportError(400, `Invalid status: ${badStatus.join(", ")}. Allowed: ${REQUEST_STATUSES.join(", ")}`);

  let expiringWithinDays = company.leaveExpiryReminderDays || 60;
  if (query.expiringWithinDays !== undefined) {
    expiringWithinDays = Number(query.expiringWithinDays);
    if (!Number.isInteger(expiringWithinDays) || expiringWithinDays < 0 || expiringWithinDays > 3650)
      throw new ReportError(400, "expiringWithinDays must be a whole number from 0 to 3650");
  }

  return {
    type,
    from,
    to,
    today,
    tz,
    groupBy,
    basis,
    policyIds:        parseList(query.policyIds),
    departmentId:     query.departmentId || null,
    userIds:          parseList(query.userIds),
    includeInactive:  parseBool(query.includeInactive),
    status,
    includeLifecycle: parseBool(query.includeLifecycle),
    expiringWithinDays,
  };
}

// UTC instants bounding company-timezone calendar dates.
const startOf = (ymd, tz) => moment.tz(ymd, tz).startOf("day").toDate();
const endOf   = (ymd, tz) => moment.tz(ymd, tz).endOf("day").toDate();
const localYmd = (d, tz) => moment.tz(d, tz).format("YYYY-MM-DD");
// Leave.startDate/endDate hold calendar dates — read them without conversion.
const calYmd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// ── Scope: employees + leave types ──────────────────────────────────────────

const employeeName = (u) => {
  const first = u.profile?.firstName || "";
  const last  = u.profile?.lastName || "";
  return last && first ? `${last}, ${first}` : (`${first} ${last}`.trim() || u.email);
};

async function resolveScope(actor, f) {
  // Supervisors only ever see their own department.
  let departmentId = f.departmentId;
  if (actor.role === "supervisor") {
    const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { departmentId: true } });
    if (!me?.departmentId) throw new ReportError(403, "You aren't assigned to a department.");
    if (departmentId && departmentId !== me.departmentId)
      throw new ReportError(403, "You can only report on your own department.");
    departmentId = me.departmentId;
  }

  const users = await prisma.user.findMany({
    where: {
      ...HUMAN_ONLY,
      companyId: actor.companyId,
      ...(departmentId && { departmentId }),
      ...(f.userIds.length && { id: { in: f.userIds } }),
      ...(!f.includeInactive && { status: "active" }),
    },
    select: {
      id: true, employeeId: true, email: true, status: true, hireDate: true,
      department: { select: { name: true } },
      profile:    { select: { firstName: true, lastName: true } },
    },
  });
  if (f.userIds.length) {
    const found = new Set(users.map((u) => u.id));
    const missing = f.userIds.filter((id) => !found.has(id));
    if (missing.length) {
      // Distinguish "outside your scope" from "inactive and not included".
      const elsewhere = await prisma.user.count({
        where: {
          id: { in: missing },
          OR: [{ companyId: { not: actor.companyId } }, ...(departmentId ? [{ departmentId: { not: departmentId } }] : [])],
        },
      });
      if (elsewhere) throw new ReportError(403, "One or more employees are outside your scope.");
    }
  }

  const policies = await prisma.leavePolicy.findMany({
    where: {
      companyId: actor.companyId,
      ...(f.policyIds.length && { id: { in: f.policyIds } }),
    },
    select: { id: true, leaveType: true, isArchived: true },
    orderBy: { leaveType: "asc" },
  });
  if (f.policyIds.length && policies.length !== new Set(f.policyIds).size)
    throw new ReportError(400, "One or more policyIds don't belong to this company.");

  const employees = new Map(
    users
      .map((u) => [u.id, {
        userId:     u.id,
        employeeId: u.employeeId ?? null,
        name:       employeeName(u),
        email:      u.email,
        department: u.department?.name ?? null,
        status:     u.status,
        hireDate:   u.hireDate ? calYmd(u.hireDate) : null,
      }])
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
  );
  return { departmentId, employees, policies };
}

// ── Ledger helpers ──────────────────────────────────────────────────────────

// Classifies one balance-changing row into report buckets (all positive except adjusted).
function bucketOf(t) {
  const h = num(t.hours);
  switch (t.type) {
    case "accrual":    return { granted: h };
    case "deduction":  return { used: -h };
    case "expired":    return { expired: -h };
    case "adjustment": return t.leaveId ? { used: -h } : { adjusted: h, creditedIn: Math.max(0, h) };
    default:           return {};
  }
}

const emptyTotals = () => ({ granted: 0, used: 0, adjusted: 0, creditedIn: 0, expired: 0 });
function addTo(acc, b) {
  for (const k of Object.keys(b)) acc[k] = (acc[k] || 0) + b[k];
}

// Balance per user|policy at a UTC instant: current balance − changes after it.
async function balancesAt(userIds, policyIds, instant) {
  const [balances, after] = await Promise.all([
    prisma.leaveBalance.findMany({
      where:  { userId: { in: userIds }, policyId: { in: policyIds } },
      select: { userId: true, policyId: true, balanceHours: true },
    }),
    prisma.leaveTransaction.groupBy({
      by:    ["userId", "policyId"],
      where: { userId: { in: userIds }, policyId: { in: policyIds }, type: { in: BALANCE_TYPES }, createdAt: { gt: instant } },
      _sum:  { hours: true },
    }),
  ]);
  const map = new Map();
  for (const b of balances) map.set(`${b.userId}|${b.policyId}`, num(b.balanceHours));
  for (const a of after) {
    const k = `${a.userId}|${a.policyId}`;
    map.set(k, (map.get(k) ?? 0) - num(a._sum.hours));
  }
  return map;
}

// ── Periods (activity) ──────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");

// Periods overlapping from..to, each clipped to the range.
function buildPeriods(company, f) {
  const fiscal = f.basis === "fiscal" && !(company.leaveYearStartMonth === 1 && company.leaveYearStartDay === 1);
  const periods = [];
  let cursor;

  // First period start containing `from`.
  if (f.groupBy === "month") {
    cursor = moment.utc(f.from).startOf("month");
  } else if (!fiscal) {
    cursor = f.groupBy === "year"
      ? moment.utc(f.from).startOf("year")
      : moment.utc(f.from).startOf("quarter");
  } else {
    const fy = fiscalYearOf(company, f.from);
    cursor = moment.utc(fyStartStr(company, fy));
    if (f.groupBy === "quarter") {
      while (moment.utc(cursor).add(3, "months").format("YYYY-MM-DD") <= f.from) cursor.add(3, "months");
    }
  }

  const step = f.groupBy === "month" ? 1 : f.groupBy === "quarter" ? 3 : 12;
  while (cursor.format("YYYY-MM-DD") <= f.to) {
    const start = cursor.format("YYYY-MM-DD");
    const end   = moment.utc(cursor).add(step, "months").subtract(1, "day").format("YYYY-MM-DD");
    let key, label;
    if (f.groupBy === "month") {
      key = cursor.format("YYYY-MM");
      label = cursor.format("MMM YYYY");
    } else if (!fiscal) {
      if (f.groupBy === "year") {
        key = f.basis === "fiscal" ? `FY${cursor.year()}` : String(cursor.year());
        label = key;
      } else {
        key = `${cursor.year()}-Q${cursor.quarter()}`;
        label = `Q${cursor.quarter()} ${cursor.year()}`;
      }
    } else {
      const fy = fiscalYearOf(company, start);
      if (f.groupBy === "year") {
        key = `FY${fy}`;
        label = fyLabel(company, fy);
      } else {
        const q = Math.round(moment.utc(start).diff(moment.utc(fyStartStr(company, fy)), "months") / 3) + 1;
        key = `FY${fy}-Q${q}`;
        label = `FQ${q} ${fyLabel(company, fy)}`;
      }
    }
    periods.push({
      key,
      label,
      start: start < f.from ? f.from : start,
      end:   end > f.to ? f.to : end,
    });
    cursor.add(step, "months");
  }
  return periods;
}

// ── Report builders ─────────────────────────────────────────────────────────

async function summaryReport(ctx) {
  const { f, company, employees, policies } = ctx;
  const userIds = [...employees.keys()];
  const policyIds = policies.map((p) => p.id);
  const toEnd = endOf(f.to, f.tz);

  const [txns, available, lots] = await Promise.all([
    prisma.leaveTransaction.findMany({
      where:  { userId: { in: userIds }, policyId: { in: policyIds }, type: { in: BALANCE_TYPES }, createdAt: { lte: toEnd } },
      select: { userId: true, policyId: true, type: true, hours: true, leaveId: true },
    }),
    balancesAt(userIds, policyIds, toEnd),
    company.leaveCreditsInitializedAt
      ? prisma.leaveCredit.findMany({
          where:   { userId: { in: userIds }, policyId: { in: policyIds } },
          orderBy: { fiscalYear: "asc" },
        })
      : [],
  ]);

  const sums = new Map();
  for (const t of txns) {
    const k = `${t.userId}|${t.policyId}`;
    if (!sums.has(k)) sums.set(k, emptyTotals());
    addTo(sums.get(k), bucketOf(t));
  }
  const lotsByKey = new Map();
  for (const l of lots) {
    const k = `${l.userId}|${l.policyId}`;
    if (!lotsByKey.has(k)) lotsByKey.set(k, []);
    lotsByKey.get(k).push(l);
  }

  const rows = [];
  const totals = { grantedHours: 0, creditedHours: 0, usedHours: 0, adjustedHours: 0, expiredHours: 0, availableHours: 0 };
  for (const emp of employees.values()) {
    for (const p of policies) {
      const k = `${emp.userId}|${p.id}`;
      if (!sums.has(k) && !available.has(k) && !lotsByKey.has(k)) continue; // never had this type
      const s = sums.get(k) ?? emptyTotals();
      const myLots = lotsByKey.get(k) ?? [];
      const creditLots = myLots.map((l) => ({
        creditId:       l.id,
        fiscalYear:     l.fiscalYear,
        label:          fyLabel(company, l.fiscalYear),
        grantedHours:   r2(l.grantedHours),
        remainingHours: r2(l.remainingHours),
        expiredHours:   r2(l.expiredHours),
        expiresOn:      dateColStr(l.expiresOn),
        expiredAt:      l.expiredAt ? l.expiredAt.toISOString() : null,
      }));
      const live = creditLots.find((l) => l.remainingHours > 0 && !l.expiredAt);
      const row = {
        employee:       emp,
        policyId:       p.id,
        leaveType:      p.leaveType,
        grantedHours:   r2(s.granted),
        creditedHours:  r2(s.granted + s.creditedIn),
        usedHours:      r2(s.used),
        adjustedHours:  r2(s.adjusted),
        expiredHours:   r2(s.expired),
        availableHours: r2(available.get(k) ?? 0),
        creditLots,
        nextExpiration: company.leaveExpirationEnabled && live ? { date: live.expiresOn, hours: live.remainingHours } : null,
      };
      rows.push(row);
      for (const key of Object.keys(totals)) totals[key] = r2(totals[key] + row[key]);
    }
  }
  return { rows, totals, extra: { creditLotsAsOf: f.today } };
}

async function activityReport(ctx) {
  const { f, company, employees, policies } = ctx;
  const userIds = [...employees.keys()];
  const policyIds = policies.map((p) => p.id);
  const periods = buildPeriods(company, f);
  const fromStart = startOf(f.from, f.tz);
  const toEnd = endOf(f.to, f.tz);

  const [txns, opening, unpaidDays] = await Promise.all([
    prisma.leaveTransaction.findMany({
      where:  { userId: { in: userIds }, policyId: { in: policyIds }, type: { in: BALANCE_TYPES }, createdAt: { gte: fromStart, lte: toEnd } },
      select: { userId: true, policyId: true, type: true, hours: true, leaveId: true, createdAt: true },
    }),
    balancesAt(userIds, policyIds, new Date(fromStart.getTime() - 1)),
    prisma.leaveDay.findMany({
      where: {
        isPaid: false,
        date:   { gte: new Date(`${f.from}T00:00:00.000Z`), lte: new Date(`${f.to}T00:00:00.000Z`) },
        leave:  { status: "approved", userId: { in: userIds } },
      },
      select: { date: true, hours: true, leave: { select: { userId: true, policyId: true, leaveType: true } } },
    }),
  ]);

  const periodOf = (ymd) => periods.find((p) => ymd >= p.start && ymd <= p.end)?.key;
  // cell key: user|policy|period
  const cells = new Map();
  const cell = (k) => {
    if (!cells.has(k)) cells.set(k, { ...emptyTotals(), unpaid: 0 });
    return cells.get(k);
  };
  const active = new Set(opening.keys());
  for (const t of txns) {
    const pk = periodOf(localYmd(t.createdAt, f.tz));
    if (!pk) continue;
    active.add(`${t.userId}|${t.policyId}`);
    addTo(cell(`${t.userId}|${t.policyId}|${pk}`), bucketOf(t));
  }
  const policyIdSet = new Set(policyIds);
  for (const d of unpaidDays) {
    // Leave.policyId is the FK; older rows keep the policy id in leaveType.
    const pid = d.leave.policyId ?? d.leave.leaveType;
    if (!policyIdSet.has(pid)) continue;
    const pk = periodOf(calYmd(d.date));
    if (!pk) continue;
    active.add(`${d.leave.userId}|${pid}`);
    cell(`${d.leave.userId}|${pid}|${pk}`).unpaid += num(d.hours);
  }

  const rows = [];
  const totals = { all: { grantedHours: 0, creditedHours: 0, usedHours: 0, unpaidHours: 0, adjustedHours: 0, expiredHours: 0 } };
  for (const p of periods) totals[p.key] = { ...totals.all };
  for (const emp of employees.values()) {
    for (const pol of policies) {
      const pair = `${emp.userId}|${pol.id}`;
      if (!active.has(pair)) continue;
      let balance = opening.get(pair) ?? 0;
      for (const per of periods) {
        const c = cells.get(`${pair}|${per.key}`) ?? { ...emptyTotals(), unpaid: 0 };
        const openingHours = balance;
        balance = balance + c.granted + c.adjusted - c.used - c.expired;
        const row = {
          employee:      emp,
          policyId:      pol.id,
          leaveType:     pol.leaveType,
          period:        per,
          openingHours:  r2(openingHours),
          grantedHours:  r2(c.granted),
          creditedHours: r2(c.granted + c.creditedIn),
          usedHours:     r2(c.used),
          unpaidHours:   r2(c.unpaid),
          adjustedHours: r2(c.adjusted),
          expiredHours:  r2(c.expired),
          closingHours:  r2(balance),
        };
        rows.push(row);
        for (const t of [totals[per.key], totals.all]) {
          for (const key of Object.keys(t)) t[key] = r2(t[key] + row[key]);
        }
      }
    }
  }
  return { rows, totals, extra: { periods } };
}

function lotState(lot, refYmd, withinDays) {
  const expiresOn = dateColStr(lot.expiresOn);
  if (lot.expiredAt || expiresOn < refYmd) return "expired";
  if (expiresOn <= moment.utc(refYmd).add(withinDays, "days").format("YYYY-MM-DD")) return "expiring_soon";
  return "active";
}

async function expirationReport(ctx) {
  const { f, company, employees, policies } = ctx;
  const totals = {
    active:        { count: 0, remainingHours: 0 },
    expiring_soon: { count: 0, remainingHours: 0 },
    expired:       { count: 0, expiredHours: 0 },
  };
  if (!company.leaveCreditsInitializedAt) return { rows: [], totals };

  // Default range: everything still usable, plus lots expired in the last 12 months.
  const where = f.from
    ? { expiresOn: { gte: new Date(`${f.from}T00:00:00.000Z`), lte: new Date(`${f.to}T00:00:00.000Z`) } }
    : {
        OR: [
          { expiredAt: null, expiresOn: { gte: new Date(`${f.to}T00:00:00.000Z`) } },
          { expiresOn: { gte: new Date(`${moment.utc(f.to).subtract(12, "months").format("YYYY-MM-DD")}T00:00:00.000Z`) } },
        ],
      };
  const lots = await prisma.leaveCredit.findMany({
    where:   { userId: { in: [...employees.keys()] }, policyId: { in: policies.map((p) => p.id) }, ...where },
    orderBy: [{ expiresOn: "asc" }, { fiscalYear: "asc" }],
  });
  const policyById = new Map(policies.map((p) => [p.id, p]));

  const rows = lots.map((l) => {
    const state = lotState(l, f.to, f.expiringWithinDays);
    const grantedHours = r2(l.grantedHours);
    const remainingHours = r2(l.remainingHours);
    const expiredHours = r2(l.expiredHours);
    const row = {
      employee:       employees.get(l.userId),
      policyId:       l.policyId,
      leaveType:      policyById.get(l.policyId)?.leaveType ?? null,
      creditId:       l.id,
      fiscalYear:     l.fiscalYear,
      label:          fyLabel(company, l.fiscalYear),
      grantedHours,
      usedHours:      r2(Math.max(0, grantedHours - remainingHours - expiredHours)),
      remainingHours,
      expiresOn:      dateColStr(l.expiresOn),
      state,
      expiredAt:      l.expiredAt ? l.expiredAt.toISOString() : null,
      expiredHours,
      reminderSentAt: l.reminderSentAt ? l.reminderSentAt.toISOString() : null,
    };
    totals[state].count += 1;
    if (state === "expired") totals.expired.expiredHours = r2(totals.expired.expiredHours + expiredHours);
    else totals[state].remainingHours = r2(totals[state].remainingHours + remainingHours);
    return row;
  });
  rows.sort((a, b) => a.employee.name.localeCompare(b.employee.name) || a.expiresOn.localeCompare(b.expiresOn));
  return { rows, totals };
}

async function requestsReport(ctx) {
  const { f, company, employees, policies } = ctx;
  const policyIds = policies.map((p) => p.id);
  const policyById = new Map(policies.map((p) => [p.id, p]));

  const leaves = await prisma.leave.findMany({
    where: {
      userId:    { in: [...employees.keys()] },
      status:    { in: f.status },
      startDate: { lte: endOf(f.to, f.tz) },
      endDate:   { gte: startOf(f.from, f.tz) },
      OR: [{ policyId: { in: policyIds } }, { policyId: null, leaveType: { in: policyIds } }],
    },
    orderBy: { startDate: "asc" },
    include: {
      days:         { select: { hours: true } },
      creditUsages: { select: { hours: true, credit: { select: { fiscalYear: true } } } },
      approver:     { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
      decidedBy:    { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });
  const leaveIds = leaves.map((l) => l.id);

  const [decisions, secondaries] = await Promise.all([
    prisma.leaveTransaction.findMany({
      where:   { leaveId: { in: leaveIds }, type: { in: ["approved", "rejected"] } },
      orderBy: { createdAt: "asc" },
      select:  { leaveId: true, createdAt: true },
    }),
    prisma.user.findMany({
      where:  { id: { in: [...new Set(leaves.map((l) => l.secondaryApproverId).filter(Boolean))] } },
      select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  const decidedAt = new Map();
  for (const d of decisions) decidedAt.set(d.leaveId, d.createdAt.toISOString()); // last one wins
  const secondaryName = new Map(secondaries.map((u) => [u.id, employeeName(u)]));

  const totals = { count: 0, byStatus: {}, paidHours: 0, unpaidHours: 0 };
  const rows = leaves.map((l) => {
    const pid = l.policyId ?? l.leaveType;
    const decided = l.actualPaidHours != null || l.actualUnpaidHours != null;
    const byFy = new Map();
    for (const u of l.creditUsages) byFy.set(u.credit.fiscalYear, (byFy.get(u.credit.fiscalYear) ?? 0) + num(u.hours));
    const row = {
      employee:          employees.get(l.userId),
      leaveId:           l.id,
      policyId:          pid,
      leaveType:         policyById.get(pid)?.leaveType ?? null,
      startDate:         calYmd(l.startDate),
      endDate:           calYmd(l.endDate),
      status:            l.status,
      isPaid:            l.isPaid,
      // LeaveDay rows exist once a leave is decided; pending requests → null.
      requestedHours:    l.days.length ? r2(l.days.reduce((s, d) => s + num(d.hours), 0)) : null,
      paidHours:         decided ? r2(l.actualPaidHours) : null,
      unpaidHours:       decided ? r2(l.actualUnpaidHours) : null,
      reason:            l.leaveReason ?? null,
      submittedAt:       l.createdAt.toISOString(),
      decidedAt:         decidedAt.get(l.id) ?? null,
      decidedBy:         l.decidedBy ? employeeName(l.decidedBy) : null,
      approver:          l.approver ? employeeName(l.approver) : null,
      secondaryApprover: l.secondaryApproverId ? secondaryName.get(l.secondaryApproverId) ?? null : null,
      creditsUsed:       company.leaveCreditsInitializedAt
        ? [...byFy.entries()].sort((a, b) => a[0] - b[0]).map(([fiscalYear, hours]) => ({ fiscalYear, label: fyLabel(company, fiscalYear), hours: r2(hours) }))
        : [],
    };
    totals.count += 1;
    totals.byStatus[l.status] = (totals.byStatus[l.status] ?? 0) + 1;
    totals.paidHours = r2(totals.paidHours + (row.paidHours ?? 0));
    totals.unpaidHours = r2(totals.unpaidHours + (row.unpaidHours ?? 0));
    return row;
  });
  return { rows, totals };
}

async function ledgerReport(ctx) {
  const { f, employees, policies } = ctx;
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const txns = await prisma.leaveTransaction.findMany({
    where: {
      userId:    { in: [...employees.keys()] },
      policyId:  { in: policies.map((p) => p.id) },
      createdAt: { gte: startOf(f.from, f.tz), lte: endOf(f.to, f.tz) },
      ...(!f.includeLifecycle && { type: { in: BALANCE_TYPES } }),
    },
    orderBy: { createdAt: "asc" },
    include: { performedBy: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } } },
  });

  const totals = { count: txns.length, byType: {} };
  const rows = txns.map((t) => {
    totals.byType[t.type] = (totals.byType[t.type] ?? 0) + 1;
    return {
      employee:      employees.get(t.userId),
      policyId:      t.policyId,
      leaveType:     policyById.get(t.policyId)?.leaveType ?? null,
      id:            t.id,
      createdAt:     t.createdAt.toISOString(),
      date:          localYmd(t.createdAt, f.tz),
      type:          t.type,
      hours:         t.hours == null ? null : r2(t.hours),
      balanceBefore: t.balanceBefore == null ? null : r2(t.balanceBefore),
      balanceAfter:  t.balanceAfter == null ? null : r2(t.balanceAfter),
      leaveId:       t.leaveId ?? null,
      performedBy:   t.performedBy ? employeeName(t.performedBy) : null,
      note:          t.note ?? null,
    };
  });
  return { rows, totals };
}

const BUILDERS = {
  summary:    summaryReport,
  activity:   activityReport,
  expiration: expirationReport,
  requests:   requestsReport,
  ledger:     ledgerReport,
};

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{ id, role, companyId }} actor  req.user
 * @param {object} query                   req.query
 */
async function buildLeaveReport(actor, query) {
  const company = await prisma.company.findUnique({
    where:  { id: actor.companyId },
    select: { ...COMPANY_CREDIT_SELECT, name: true },
  });
  if (!company) throw new ReportError(404, "Company not found.");

  const f = parseFilters(query, company);
  const { departmentId, employees, policies } = await resolveScope(actor, f);
  const ctx = { f, company, employees, policies };

  const { rows, totals, extra } = employees.size && policies.length
    ? await BUILDERS[f.type](ctx)
    : { rows: [], totals: {} };

  return {
    type:        f.type,
    generatedAt: new Date().toISOString(),
    company:     { id: company.id, name: company.name, timezone: f.tz },
    filters: {
      from:               f.from,
      to:                 f.to,
      groupBy:            f.groupBy,
      basis:              f.basis,
      policyIds:          policies.map((p) => p.id),
      departmentId,
      userIds:            f.userIds,
      includeInactive:    f.includeInactive,
      status:             f.status,
      includeLifecycle:   f.includeLifecycle,
      expiringWithinDays: f.expiringWithinDays,
    },
    settings: {
      leaveCreditsInitializedAt: company.leaveCreditsInitializedAt ? company.leaveCreditsInitializedAt.toISOString() : null,
      leaveGrantEnabled:         company.leaveGrantEnabled,
      leaveExpirationEnabled:    company.leaveExpirationEnabled,
      leaveGrantMode:            company.leaveGrantMode,
      leaveGrantHours:           num(company.leaveGrantHours),
      leaveYearStartMonth:       company.leaveYearStartMonth,
      leaveYearStartDay:         company.leaveYearStartDay,
      leaveCreditLifetimeYears:  company.leaveCreditLifetimeYears,
      leaveExpiryReminderDays:   company.leaveExpiryReminderDays,
    },
    policies,
    ...(extra || {}),
    rows,
    totals,
  };
}

module.exports = { buildLeaveReport, ReportError, REPORT_TYPES };
