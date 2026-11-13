// src/services/Reports/punchLogPayrollGrid.js
//
// BB-119 phase 1c (docs/changelog-v2.11.7.md): the company Punch Logs
// "Payroll Grid" CSV, built on the server. A port of the client's
// lib/exports/employeePunchLogs.js:exportEmployeePunchLogsCSV_v2 plus the data
// assembly in EmployeesPunchLogs.jsx:handleGenerateReport, on the shared
// read-only builder (punchLogReportService.buildPunchLogReport).
//
// Same layout as before:
//   row 1  ""  ""  ""  ""  | per date: "" <day> "" | Total Hours "" "" | Driving Hrs | TR | SL | OT | Total | "" | TR - Training
//   row 2  ""  ID  Name of Employee  Role | per date: Driver Aide AM, Regular, Driver Aide PM | Driver Aide AM, Regular, Driver Aide PM, AM + PM, …, SL - Sick Leave
//   one row per employee (Last, First), then a Total row.
//   Daily cells: AM / Regular (+ Training) / PM hours; blank when 0.
//   Totals: AM, Regular, PM, Driving (AM + PM), TR, SL, OT, Total (AM + Regular + PM + TR, + fixed-hours OT).
//   BB-089 fixed-hours employees: Regular = fixed hours − SL, AM/PM/TR = 0, role "(fixed hours)",
//   Total = Regular + their approved off-day OT; listed even with no punches.
//
// Intended differences from the browser version (see client hand-off item 14):
//   - SL: every approved, paid sick leave in range (the page only loaded its newest 50
//     leave requests), using the leave's real paid days (LeaveDay) when it has them.
//   - OT: the approved overtime the cutoff review records — per-cutoff OT records for
//     cutoff-basis companies (training excluded, as the cutoff review counts it), daily
//     OT blocks for B&C, approved OT requests for daily/weekly companies.
//   - ID: the company employee ID only, never the internal user id.
//
// READ-ONLY. Sick-leave reading mirrors cutoffPeriodController.js:getCutoffApprovals
// ("standalone leave rows") for locked cutoffs.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { calcDailyHours } = require("@utils/leaveUtils");
const { buildPunchLogReport, reportFileName } = require("@services/Reports/punchLogReportService");

const DA_TYPES = new Set(["DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"]);
const calYmd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const n = (v) => Number(v) || 0;
const cell = (v) => (v > 0 ? v.toFixed(2) : "");
const dayDiff = (a, b) => moment.utc(b).diff(moment.utc(a), "days") + 1;

// mirrors lib/leaveBalanceUtils.js:resolveLeavePayOutcome
function payOutcome(leave) {
  if (leave.isPaid == null) return null;
  if (leave.status === "approved" && (leave.actualPaidHours != null || leave.actualUnpaidHours != null)) {
    const paid = n(leave.actualPaidHours);
    const unpaid = n(leave.actualUnpaidHours);
    if (paid > 0 && unpaid > 0) return "partial";
    if (unpaid > 0) return "unpaid";
    if (paid > 0) return "paid";
  }
  return leave.isPaid ? "paid" : "unpaid";
}

// Approved sick leaves of these users touching [from, to], with their LeaveDay rows.
async function loadSickLeaves(userIds, from, to) {
  if (!userIds.length) return [];
  const leaves = await prisma.leave.findMany({
    where: {
      userId: { in: userIds },
      status: "approved",
      startDate: { lte: new Date(`${to}T23:59:59.999Z`) },
      endDate: { gte: new Date(`${from}T00:00:00.000Z`) },
    },
    select: {
      id: true, userId: true, leaveType: true, policyId: true, startDate: true, endDate: true, status: true,
      isPaid: true, actualPaidHours: true, actualUnpaidHours: true, excludedShiftIds: true, includeWeekends: true,
      days: { select: { date: true, isPaid: true, hours: true } },
    },
  });
  const policyIds = [...new Set(leaves.map((l) => l.policyId || l.leaveType).filter(Boolean))];
  const policies = policyIds.length
    ? await prisma.leavePolicy.findMany({ where: { id: { in: policyIds } }, select: { id: true, leaveType: true } })
    : [];
  const nameOf = new Map(policies.map((p) => [p.id, p.leaveType]));
  return leaves.filter((l) => String(nameOf.get(l.policyId || l.leaveType) || l.leaveType || "").toLowerCase().includes("sick"));
}

/**
 * Sick-leave hours per user.
 *  - Locked/processed cutoff (based on getCutoffApprovals' standalone leave rows): each
 *    leave day inside the cutoff with no counted punch that day — the paid LeaveDay hours,
 *    or for a legacy leave without LeaveDay rows, the scheduled hours when the leave is
 *    paid. BB-124: a day whose punches were all excluded counts as no punch (the cutoff
 *    review page still treats it as punched).
 *  - Live data: the paid sick hours inside the report range — LeaveDay rows when present,
 *    otherwise the old browser rule (paid hours × overlapping days / leave days).
 */
async function sickLeaveHours(report, employees, defaultShiftHours) {
  const sl = new Map();
  const add = (userId, h) => h > 0 && sl.set(userId, (sl.get(userId) || 0) + h);

  // Who is covered by which reviewed (locked) cutoff.
  const lockedByPeriod = new Map(); // periodId → Set(userId)
  for (const r of report.rows) {
    if (r.basis !== "reviewed") continue;
    if (!lockedByPeriod.has(r.cutoffPeriodId)) lockedByPeriod.set(r.cutoffPeriodId, new Set());
    lockedByPeriod.get(r.cutoffPeriodId).add(r.userId);
  }
  for (const fh of report.fixedHours) {
    if (!lockedByPeriod.has(fh.cutoffPeriodId)) lockedByPeriod.set(fh.cutoffPeriodId, new Set());
    lockedByPeriod.get(fh.cutoffPeriodId).add(fh.userId);
  }
  const lockedUsers = new Set([...lockedByPeriod.values()].flatMap((s) => [...s]));

  // ── Locked cutoffs ──
  for (const [periodId, users] of lockedByPeriod) {
    const p = report.periods.find((x) => x.id === periodId);
    if (!p) continue;
    // BB-124: a day whose punches were all excluded in cutoff review (e.g. "Honor
    // Leave") isn't a worked day — its paid leave still counts. Only days with an
    // approved or pending punch block the leave.
    const punched = new Set(
      report.rows
        .filter((r) => r.cutoffPeriodId === periodId && r.cutoffStatus !== "Excluded")
        .map((r) => `${r.userId}|${r.date}`)
    );
    for (const leave of await loadSickLeaves([...users], p.start, p.end)) {
      const start = calYmd(leave.startDate);
      const end = calYmd(leave.endDate);
      const hasDays = leave.days.length > 0;
      const paidByDate = new Map();
      for (const d of leave.days) if (d.isPaid) paidByDate.set(calYmd(d.date), (paidByDate.get(calYmd(d.date)) || 0) + n(d.hours));
      let scheduled = null;
      if (!hasDays && leave.isPaid) {
        const daily = await calcDailyHours(leave.userId, start, end, {
          excludeShiftIds: Array.isArray(leave.excludedShiftIds) ? leave.excludedShiftIds : [],
          includeWeekends: leave.includeWeekends !== false,
        }).catch(() => []);
        scheduled = new Map(daily.map((d) => [d.date, d.hours]));
      }
      for (let d = moment.utc(start); d.isSameOrBefore(moment.utc(end)); d.add(1, "day")) {
        const ymd = d.format("YYYY-MM-DD");
        if (ymd < p.start || ymd > p.end || punched.has(`${leave.userId}|${ymd}`)) continue;
        add(leave.userId, hasDays ? paidByDate.get(ymd) || 0 : leave.isPaid ? n(scheduled?.get(ymd)) : 0);
      }
    }
  }

  // ── Live data ──
  const liveUsers = employees.filter((id) => !lockedUsers.has(id));
  const from = report.filters.rangeFrom;
  const to = report.filters.rangeTo;
  for (const leave of await loadSickLeaves(liveUsers, from, to)) {
    const outcome = payOutcome(leave);
    if (outcome === "unpaid" || outcome === null) continue;
    if (leave.days.length) {
      add(leave.userId, leave.days.filter((d) => d.isPaid && calYmd(d.date) >= from && calYmd(d.date) <= to).reduce((t, d) => t + n(d.hours), 0));
      continue;
    }
    // Legacy leave (no LeaveDay rows): the browser's proportional rule.
    const start = calYmd(leave.startDate);
    const end = calYmd(leave.endDate);
    const oStart = start > from ? start : from;
    const oEnd = end < to ? end : to;
    if (oStart > oEnd) continue;
    const base = leave.actualPaidHours != null ? n(leave.actualPaidHours) : null;
    add(leave.userId, base != null ? base * (dayDiff(oStart, oEnd) / dayDiff(start, end)) : dayDiff(oStart, oEnd) * defaultShiftHours);
  }
  return sl;
}

/**
 * Approved overtime per user, as the cutoff review / payroll records it.
 * @returns {Map<userId, number>}
 */
async function approvedOvertime(report, employees) {
  const ot = new Map();
  const add = (userId, h) => h > 0 && ot.set(userId, (ot.get(userId) || 0) + h);
  const { company, filters, periods } = report;
  if (!employees.length) return ot;

  if (company.isBnC || company.otBasis === "cutoff") {
    // B&C: daily OT blocks in range. Cutoff basis: one block per employee per cutoff —
    // the chosen cutoffs, or (date range) every cutoff overlapping the range.
    const where = { userId: { in: employees }, status: "approved" };
    if (company.isBnC) {
      where.date = { gte: new Date(`${filters.rangeFrom}T00:00:00.000Z`), lte: new Date(`${filters.rangeTo}T00:00:00.000Z`) };
      if (periods.length) where.cutoffPeriodId = { in: periods.map((p) => p.id) };
    } else if (periods.length) {
      where.cutoffPeriodId = { in: periods.map((p) => p.id) };
    } else {
      where.cutoffPeriod = { periodStart: { lte: new Date(`${filters.rangeTo}T23:59:59.999Z`) }, periodEnd: { gte: new Date(`${filters.rangeFrom}T00:00:00.000Z`) } };
    }
    const blocks = await prisma.cutoffOtBlock.findMany({ where, select: { userId: true, otHours: true } });
    for (const b of blocks) add(b.userId, n(b.otHours));
    return ot;
  }
  // Daily / weekly basis: approved OT requests on the punches.
  for (const r of report.rows) if (r.otStatus === "Approved") add(r.userId, n(r.otHours));
  return ot;
}

/**
 * @param {{ id, role, companyId, agentId? }} actor  req.user
 * @param {object} query  same as /api/reports/punch-logs (scope is always team)
 * @returns {Promise<{ report, dates, employees, grand, headers: string[], rows: string[][], fileName: (ext) => string }>}
 */
async function buildPayrollGrid(actor, query = {}) {
  const report = await buildPunchLogReport(actor, { ...query, scope: "team" });
  const { company, rows, fixedHours } = report;
  const defaultShift = Number(company.defaultShiftHours) || 8;

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const fixedByUser = new Map();
  for (const fh of fixedHours) fixedByUser.set(fh.userId, (fixedByUser.get(fh.userId) || 0) + n(fh.hours));
  const employees = [...new Set([...rows.map((r) => r.userId), ...fixedByUser.keys()])];

  const [people, sl, ot] = await Promise.all([
    employees.length
      ? prisma.user.findMany({
          where: { id: { in: employees } },
          select: { id: true, email: true, employeeId: true, profile: { select: { firstName: true, lastName: true } }, employmentDetail: { select: { jobTitle: true } } },
        })
      : [],
    sickLeaveHours(report, employees, defaultShift),
    approvedOvertime(report, employees),
  ]);
  const personById = new Map(people.map((u) => [u.id, u]));
  const nameOf = (u) => {
    const first = (u?.profile?.firstName || "").trim();
    const last = (u?.profile?.lastName || "").trim();
    return first && last ? `${last}, ${first}` : last || first || u?.email || "—";
  };
  const sorted = employees
    .map((id) => personById.get(id) || { id })
    .sort(
      (a, b) =>
        (a.profile?.lastName || "").toLowerCase().localeCompare((b.profile?.lastName || "").toLowerCase()) ||
        (a.profile?.firstName || "").toLowerCase().localeCompare((b.profile?.firstName || "").toLowerCase()) ||
        nameOf(a).localeCompare(nameOf(b))
    );

  // ── Header rows ──
  const dateRow = ["", "", "", ""];
  for (const d of dates) dateRow.push("", String(Number(d.slice(8, 10))), "");
  dateRow.push("Total Hours", "", "", "Driving Hrs", "TR", "SL", "OT", "Total", "", "TR - Training");
  const colRow = ["", "ID", "Name of Employee", "Role"];
  for (let i = 0; i < dates.length; i++) colRow.push("Driver Aide AM", "Regular", "Driver Aide PM");
  colRow.push("Driver Aide AM", "Regular", "Driver Aide PM", "AM + PM", "", "", "", "", "", "SL - Sick Leave");

  // ── Employee rows ──
  const byUserDate = new Map();
  for (const r of rows) {
    const k = `${r.userId}|${r.date}`;
    if (!byUserDate.has(k)) byUserDate.set(k, []);
    byUserDate.get(k).push(r);
  }
  const grand = { am: 0, reg: 0, pm: 0, driving: 0, tr: 0, sl: 0, ot: 0, fixedOt: 0 };
  const dataRows = [];
  const gridEmployees = []; // the same figures as numbers, for the Excel version

  for (const u of sorted) {
    const isFixed = fixedByUser.has(u.id);
    let tAM = 0, tReg = 0, tPM = 0, tTR = 0;
    const row = ["", u.employeeId || "", nameOf(u), u.employmentDetail?.jobTitle || "—"];
    const days = [];

    for (const d of dates) {
      const logs = byUserDate.get(`${u.id}|${d}`) || [];
      if (!logs.length) {
        row.push("", "", "");
        days.push(null);
        continue;
      }
      // mirrors exportEmployeePunchLogsCSV_v2: every record of the day counts.
      let am = 0, reg = 0, pm = 0, tr = 0, svSched = 0;
      for (const r of logs) {
        svSched += n(r.fixedHoursScheduledHours);
        const training = r.punchType === "TRAINING";
        const da = DA_TYPES.has(r.punchType);
        am += da && r.am != null ? n(r.am) : 0;
        reg += da && r.regular != null ? n(r.regular) : training ? 0 : n(r.worked);
        pm += da && r.pm != null ? n(r.pm) : 0;
        tr += training ? n(r.worked) : 0;
      }
      tAM += am;
      tReg += reg;
      tPM += pm;
      tTR += tr;
      // Training shows under Regular per day; fixed-hours scheduled days show the actual hours, capped at one shift.
      const cellReg = reg + tr + (isFixed ? Math.min(svSched, defaultShift) : 0);
      row.push(cell(am), cell(cellReg), cell(pm));
      days.push({ am, regular: cellReg, pm });
    }

    const slH = sl.get(u.id) || 0;
    const otH = ot.get(u.id) || 0;
    const fixedOt = isFixed ? otH : 0;
    if (isFixed) {
      tAM = 0;
      tPM = 0;
      tTR = 0;
      tReg = Math.max(0, fixedByUser.get(u.id) - slH);
      row[3] = `${row[3]} (fixed hours)`;
    }
    const driving = tAM + tPM;
    const total = tAM + tReg + tPM + tTR + fixedOt;
    row.push(cell(tAM), cell(tReg), cell(tPM), cell(driving), cell(tTR), cell(slH), cell(otH), cell(total));
    dataRows.push(row);
    gridEmployees.push({
      userId: u.id,
      employeeId: u.employeeId || null,
      name: nameOf(u),
      role: row[3],
      isFixed,
      days,
      totals: { am: tAM, regular: tReg, pm: tPM, driving, training: tTR, sick: slH, overtime: otH, total },
    });

    grand.am += tAM;
    grand.reg += tReg;
    grand.pm += tPM;
    grand.driving += driving;
    grand.tr += tTR;
    grand.sl += slH;
    grand.ot += otH;
    grand.fixedOt += fixedOt;
  }

  const totalRow = ["Total", "", "", ""];
  for (let i = 0; i < dates.length; i++) totalRow.push("", "", "");
  totalRow.push(
    cell(grand.am), cell(grand.reg), cell(grand.pm), cell(grand.driving), cell(grand.tr), cell(grand.sl), cell(grand.ot),
    cell(grand.am + grand.reg + grand.pm + grand.tr + grand.fixedOt)
  );

  return {
    report,
    dates,
    employees: gridEmployees,
    grand: {
      am: grand.am, regular: grand.reg, pm: grand.pm, driving: grand.driving, training: grand.tr,
      sick: grand.sl, overtime: grand.ot, total: grand.am + grand.reg + grand.pm + grand.tr + grand.fixedOt,
    },
    // CSV (format=payroll-csv): the original two-header-row layout
    headers: dateRow,
    rows: [colRow, ...dataRows, totalRow],
    fileName: (ext) => reportFileName(report, ext, "PunchLogs_PayrollGrid"),
  };
}

module.exports = { buildPayrollGrid };
