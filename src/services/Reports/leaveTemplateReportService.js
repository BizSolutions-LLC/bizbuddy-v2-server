// src/services/Reports/leaveTemplateReportService.js
//
// BB-106 — the "Leave Report" button: one sheet per leave type, shaped like
// docs/LeaveReport_Template.csv:
//
//   # | NAME | DOH | Beg Bal Y-1 | Total Used Y-1 | Balance Y-1 | Y credits |
//   Beg Bal Y | <one column per pay date, grouped by month> |
//   Total Used Y | Balance Y | Beg Bal Y+1
//
// Columns are cutoff PAYMENT dates. A paid leave day counts under the cutoff
// whose periodStart–periodEnd contains it, so a late-December day can land
// under the next year's first pay date (e.g. Jan 9). "Year Y" is every cutoff
// paid in Y. With no cutoffs for a year, calendar months stand in for them.
//
// Each year is worked out as:
//   Beg Y-1 = ledger balance just before Y-1's window (balancesAt walk-back)
//   Credits = accrual + admin adjustments (not tied to a leave) − expired,
//             by ledger date, inside the window (bucketOf semantics)
//   Used    = approved paid LeaveDay hours whose date is inside the window
//   Balance = Beg + Credits − Used
//   Beg Y   = Balance Y-1
//   Beg Y+1 = Balance Y + next year's automatic grant (when the company has
//             grants on and the employee is eligible for this type)
//
// With a quarter/month filter only the selected pay dates are shown. Total
// Used Y is the sum of those columns, and Balance Y is the balance as of the
// last selected cutoff's end, so earlier unselected usage is still deducted.
//
// Cutoff dates and LeaveDay.date are calendar dates (UTC midnight), so they
// are compared as YYYY-MM-DD strings. Ledger rows are timestamps and are read
// in the company timezone.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { COMPANY_CREDIT_SELECT, isTracked } = require("@services/Leave/leaveCreditService");
const {
  ReportError,
  BALANCE_TYPES,
  DEFAULT_TZ,
  r2,
  num,
  parseList,
  parseBool,
  startOf,
  endOf,
  localYmd,
  calYmd,
  resolveScope,
  balancesAt,
  bucketOf,
} = require("@services/Reports/leaveReportService");

const MONTH_KEYS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUARTER_KEYS = ["Q1", "Q2", "Q3", "Q4"];

const dayBefore = (ymd) => moment.utc(ymd).subtract(1, "day").format("YYYY-MM-DD");

// ── Filters ─────────────────────────────────────────────────────────────────

function parseTemplateFilters(query, tz) {
  const currentYear = Number(moment.tz(tz).format("YYYY"));
  const year = query.year === undefined || query.year === "" ? currentYear : Number(query.year);
  if (!Number.isInteger(year) || year < 2000 || year > currentYear + 1)
    throw new ReportError(400, `year must be a whole year from 2000 to ${currentYear + 1}`);

  const quarters = parseList(query.quarters);
  const months = parseList(query.months);
  if (quarters.length && months.length)
    throw new ReportError(400, "Send either quarters or months, not both.");

  const badQ = quarters.filter((q) => !QUARTER_KEYS.includes(q));
  if (badQ.length) throw new ReportError(400, `Invalid quarters: ${badQ.join(", ")}. Allowed: ${QUARTER_KEYS.join(", ")}`);
  const badM = months.filter((m) => !MONTH_KEYS.includes(m));
  if (badM.length) throw new ReportError(400, `Invalid months: ${badM.join(", ")}. Allowed: ${MONTH_KEYS.join(", ")}`);

  // Selected month indexes (0–11); all twelve when nothing was picked.
  let monthIdx = MONTH_KEYS.map((_, i) => i);
  let groupBy = "year";
  let periods = [];
  if (quarters.length) {
    groupBy = "quarter";
    periods = QUARTER_KEYS.filter((q) => quarters.includes(q));
    monthIdx = monthIdx.filter((i) => periods.includes(QUARTER_KEYS[Math.floor(i / 3)]));
  } else if (months.length) {
    groupBy = "month";
    periods = MONTH_KEYS.filter((m) => months.includes(m));
    monthIdx = monthIdx.filter((i) => periods.includes(MONTH_KEYS[i]));
  }

  return {
    year,
    groupBy,
    periods,
    monthIdx: new Set(monthIdx),
    isFullYear: monthIdx.length === 12,
    // resolveScope() reads these:
    policyIds:       parseList(query.policyIds),
    departmentId:    query.departmentId || null,
    userIds:         parseList(query.userIds),
    includeInactive: parseBool(query.includeInactive),
  };
}

// ── Pay-date columns ────────────────────────────────────────────────────────

// Cutoffs paid in `year`, sorted by pay date, one per pay date. Prefers the
// filtered department's own cutoffs, then company-wide ones, then any.
function cutoffsForYear(all, year, departmentId) {
  const inYear = all.filter((c) => c.paymentDate.startsWith(`${year}-`));
  const own = departmentId ? inYear.filter((c) => c.departmentId === departmentId) : [];
  const companyWide = inYear.filter((c) => c.departmentId === null);
  const pick = own.length ? own : companyWide.length ? companyWide : inYear;

  const byPayDate = new Map();
  for (const c of pick.sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
    if (!byPayDate.has(c.paymentDate)) byPayDate.set(c.paymentDate, c);
  }
  const list = [...byPayDate.values()].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  if (list.length) return { cutoffs: list, source: "cutoff" };

  // No cutoffs: calendar months stand in, "paid" on the month's last day.
  return {
    source: "calendar",
    cutoffs: MONTH_KEYS.map((_, i) => {
      const m = moment.utc({ year, month: i, day: 1 });
      const end = moment.utc(m).endOf("month").format("YYYY-MM-DD");
      return { periodStart: m.format("YYYY-MM-DD"), periodEnd: end, paymentDate: end, departmentId: null };
    }),
  };
}

const monthOf = (ymd) => Number(ymd.slice(5, 7)) - 1;

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * @param {{ id, role, companyId }} actor  req.user
 * @param {object} query                   req.query
 * @returns sheet models for generateLeaveReportXlsx
 */
async function buildLeaveTemplateReport(actor, query) {
  const company = await prisma.company.findUnique({
    where:  { id: actor.companyId },
    select: { ...COMPANY_CREDIT_SELECT, name: true },
  });
  if (!company) throw new ReportError(404, "Company not found.");

  const tz = company.timeZone || DEFAULT_TZ;
  const f = parseTemplateFilters(query, tz);
  const { departmentId, employees, policies } = await resolveScope(actor, f);
  const Y = f.year;

  const header = {
    company:     { id: company.id, name: company.name, timezone: tz },
    generatedAt: new Date().toISOString(),
    year:        Y,
    groupBy:     f.groupBy,
    periods:     f.periods,
    departmentId,
  };
  if (!employees.size || !policies.length) return { ...header, columnSource: null, sheets: [] };

  // Cutoffs paid in Y-1 and Y.
  const rawCutoffs = await prisma.cutoffPeriod.findMany({
    where: {
      companyId:   actor.companyId,
      paymentDate: { gte: new Date(`${Y - 1}-01-01T00:00:00.000Z`), lte: new Date(`${Y}-12-31T23:59:59.999Z`) },
    },
    select: { periodStart: true, periodEnd: true, paymentDate: true, departmentId: true },
  });
  const allCutoffs = rawCutoffs.map((c) => ({
    periodStart:  calYmd(c.periodStart),
    periodEnd:    calYmd(c.periodEnd),
    paymentDate:  calYmd(c.paymentDate),
    departmentId: c.departmentId,
  }));
  const prev = cutoffsForYear(allCutoffs, Y - 1, departmentId);
  const curr = cutoffsForYear(allCutoffs, Y, departmentId);

  // Contiguous windows: Y-1 runs up to the day before Y starts.
  const prevStart = prev.cutoffs[0].periodStart;
  const currStart = curr.cutoffs[0].periodStart;
  const prevEnd   = dayBefore(currStart);
  const columns   = curr.cutoffs.filter((c) => f.monthIdx.has(monthOf(c.paymentDate)));
  const currEnd   = f.isFullYear || !columns.length
    ? curr.cutoffs[curr.cutoffs.length - 1].periodEnd
    : columns[columns.length - 1].periodEnd;

  const userIds = [...employees.keys()];
  const policyIds = policies.map((p) => p.id);
  const policyIdSet = new Set(policyIds);

  const [opening, txns, paidDays, policyAssign, balances] = await Promise.all([
    balancesAt(userIds, policyIds, new Date(startOf(prevStart, tz).getTime() - 1)),
    prisma.leaveTransaction.findMany({
      where: {
        userId:    { in: userIds },
        policyId:  { in: policyIds },
        type:      { in: BALANCE_TYPES },
        createdAt: { gte: startOf(prevStart, tz), lte: endOf(currEnd, tz) },
      },
      select: { userId: true, policyId: true, type: true, hours: true, leaveId: true, createdAt: true },
    }),
    prisma.leaveDay.findMany({
      where: {
        isPaid: true,
        date:   { gte: new Date(`${prevStart}T00:00:00.000Z`), lte: new Date(`${currEnd}T00:00:00.000Z`) },
        leave:  { status: "approved", userId: { in: userIds } },
      },
      select: { date: true, hours: true, leave: { select: { userId: true, policyId: true, leaveType: true } } },
    }),
    prisma.leavePolicy.findMany({
      where:  { id: { in: policyIds } },
      select: { id: true, assignedToAll: true, assignments: { select: { userId: true } } },
    }),
    prisma.leaveBalance.findMany({
      where:  { userId: { in: userIds }, policyId: { in: policyIds } },
      select: { userId: true, policyId: true },
    }),
  ]);

  // Per user|policy accumulators.
  const acc = new Map();
  const get = (k) => {
    if (!acc.has(k)) acc.set(k, { prevCredits: 0, currCredits: 0, prevUsed: 0, currUsedToEnd: 0, cells: new Array(columns.length).fill(0) });
    return acc.get(k);
  };
  const hasData = new Set([...opening.keys(), ...balances.map((b) => `${b.userId}|${b.policyId}`)]);

  for (const t of txns) {
    const b = bucketOf(t);
    if (b.used !== undefined) continue; // usage comes from LeaveDay below
    const credit = (b.granted || 0) + (b.adjusted || 0) - (b.expired || 0);
    const k = `${t.userId}|${t.policyId}`;
    hasData.add(k);
    const ymd = localYmd(t.createdAt, tz);
    if (ymd <= prevEnd) get(k).prevCredits += credit;
    else get(k).currCredits += credit;
  }

  for (const d of paidDays) {
    const pid = d.leave.policyId ?? d.leave.leaveType; // older rows keep the policy id in leaveType
    if (!policyIdSet.has(pid)) continue;
    const k = `${d.leave.userId}|${pid}`;
    hasData.add(k);
    const ymd = calYmd(d.date);
    const h = num(d.hours);
    const a = get(k);
    if (ymd <= prevEnd) { a.prevUsed += h; continue; }
    a.currUsedToEnd += h;
    const col = columns.findIndex((c) => ymd >= c.periodStart && ymd <= c.periodEnd);
    if (col >= 0) a.cells[col] += h;
  }

  // Projected automatic grant for next year (full leaveGrantHours in both modes).
  const grantOn = company.leaveGrantEnabled && isTracked(company) && num(company.leaveGrantHours) > 0;
  const assignById = new Map(policyAssign.map((p) => [p.id, p]));
  const eligible = (pol, userId) => {
    const a = assignById.get(pol.id);
    return !pol.isArchived && a && (a.assignedToAll || a.assignments.some((x) => x.userId === userId));
  };

  const sheets = [];
  for (const pol of policies) {
    const rows = [];
    for (const emp of employees.values()) {
      const k = `${emp.userId}|${pol.id}`;
      const isEligible = eligible(pol, emp.userId);
      if (!hasData.has(k) && !isEligible) continue;

      const a = acc.get(k) ?? { prevCredits: 0, currCredits: 0, prevUsed: 0, currUsedToEnd: 0, cells: new Array(columns.length).fill(0) };
      const prevBeg = opening.get(k) ?? 0;
      const prevBal = prevBeg + a.prevCredits - a.prevUsed;
      const balance = prevBal + a.currCredits - a.currUsedToEnd;
      const projected = grantOn && isEligible && emp.status === "active" ? num(company.leaveGrantHours) : 0;

      rows.push({
        employee:   emp,
        prevBeg:    r2(prevBeg),
        prevUsed:   r2(a.prevUsed),
        prevBal:    r2(prevBal),
        credits:    r2(a.currCredits),
        beg:        r2(prevBal),
        cells:      a.cells.map(r2),
        totalUsed:  r2(a.cells.reduce((s, h) => s + h, 0)),
        balance:    r2(balance),
        nextGrant:  r2(projected),
        nextBeg:    r2(balance + projected),
      });
    }
    if (!rows.length) continue;

    const sum = (field) => r2(rows.reduce((s, r) => s + r[field], 0));
    sheets.push({
      policyId:  pol.id,
      leaveType: pol.leaveType,
      isArchived: pol.isArchived,
      rows,
      totals: {
        prevBeg:   sum("prevBeg"),
        prevUsed:  sum("prevUsed"),
        prevBal:   sum("prevBal"),
        credits:   sum("credits"),
        beg:       sum("beg"),
        cells:     columns.map((_, i) => r2(rows.reduce((s, r) => s + r.cells[i], 0))),
        totalUsed: sum("totalUsed"),
        balance:   sum("balance"),
        nextBeg:   sum("nextBeg"),
      },
    });
  }

  return {
    ...header,
    columnSource: curr.source, // "cutoff" | "calendar" (no cutoffs paid in Y)
    windows: { prev: { start: prevStart, end: prevEnd }, curr: { start: currStart, end: currEnd } },
    columns: columns.map((c) => ({ ...c, month: monthOf(c.paymentDate), day: Number(c.paymentDate.slice(8, 10)) })),
    sheets,
  };
}

module.exports = { buildLeaveTemplateReport, MONTH_KEYS, QUARTER_KEYS };
