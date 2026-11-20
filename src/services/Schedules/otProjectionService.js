// src/services/Schedules/otProjectionService.js
//
// BB-135: Roster OT warning. For GET /api/usershifts/range?includeOt=1.
// Projects, from SCHEDULED shifts only, whether an employee will go over the
// company's OT limit. A planning warning: punches, worked hours and OT requests
// are not read, and nothing is created or changed. Every company type.
//
// Rules (user decisions 2026-11-18):
//   - Hours per day = net, like a punch (timeLogComputeService):
//       sum of shift lengths (custom times when set; overnight +24 h)
//       − lunch, ONCE per employee per day (a day's shifts can be one Driver/Aide
//         punch or several punches; the schedule can't tell, so this is an estimate):
//           auto-lunch on + entitled (department or shift config, per autoBreakBasis)
//             and the longest shift fits afterHours + minutes → its minutes if
//             deductible, else 0; otherwise the company minimumLunchMinutes
//       − auto-coffee, only when on + entitled + deductible (count × minutes)
//   - A shift counts fully on its assignedDate (start date). Cancelled skipped.
//   - Periods: daily = the date; weekly = ISO week Mon–Sun (as OT requests);
//     cutoff = payroll's periods, per the employee's department (see resolver).
//   - Whole periods count, even the parts outside from–to.
//   - BB-089 fixed-hours employees: scheduled duty is never OT → fixedHours: true, overBy 0.
//
// Cutoff periods that don't exist yet ("rightful design", user 2026-11-18):
//   1. generated  — a real CutoffPeriod row covers the date.
//   2. projected (latest_period) — after the latest row, continue with the same
//      length, exactly as jobs/autoGenerateCutoffPeriodsJob.js will create them
//      (only while that department's cutoff settings are active).
//   3. projected (cutoff_settings) — no rows yet: from DepartmentCutoffSettings
//      (startDate + frequency, same arithmetic as cutoffGenerationService).
//   4. projected (company_seed) — CompanyCutoffSettings seed + durationDays.
//   5. unknown — none of the above (or a date before / between generated
//      periods). Hours are still shown; overBy and crossesOn are null.
// A department with no rows and no settings of its own uses the company-wide
// ones (departmentId = null).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const DAY = "YYYY-MM-DD";
const MAX_WALK = 2000;

const d = (s) => moment.utc(s, DAY, true);
const fmt = (m) => m.format(DAY);
const addDays = (s, n) => fmt(d(s).add(n, "days"));
const utcDay = (date) => new Date(date).toISOString().slice(0, 10); // CutoffPeriod / @db.Date are UTC midnight
const round2 = (n) => Math.round(n * 100) / 100;

const BREAK_FIELDS = {
  autoLunchEntitled: true,
  autoBreakLunchMinutes: true,
  autoBreakLunchAfterHours: true,
  autoBreakLunchDeductible: true,
  autoCoffeeEntitled: true,
  autoBreakCoffeeMinutes: true,
  autoBreakCoffeeCount: true,
  autoBreakCoffeeDeductible: true,
};

// ── Shift hours ───────────────────────────────────────────────────────────────

const minutesOfTime = (t) => {
  const x = new Date(t);
  return x.getUTCHours() * 60 + x.getUTCMinutes() + x.getUTCSeconds() / 60;
};

/** Length of one assigned shift in minutes (custom times when both are set). */
function shiftMinutes(us) {
  const useCustom = us.customStartTime && us.customEndTime;
  const start = minutesOfTime(useCustom ? us.customStartTime : us.shift.startTime);
  const end = minutesOfTime(useCustom ? us.customEndTime : us.shift.endTime);
  let len = end - start;
  if (len <= 0) len += 24 * 60; // overnight (crossesMidnight) or 24 h
  return len;
}

/** True when the shift ends on the next day (counted fully on its start date). */
function isOvernight(us) {
  const useCustom = us.customStartTime && us.customEndTime;
  const start = minutesOfTime(useCustom ? us.customStartTime : us.shift.startTime);
  const end = minutesOfTime(useCustom ? us.customEndTime : us.shift.endTime);
  return end <= start;
}

/**
 * One employee's day, broken down (BB-135 addendum: shown in the Roster tooltip).
 * lunchRule:   "auto_lunch" | "auto_lunch_not_deducted" | "minimum_lunch"
 *              | "minimum_lunch_auto_too_short" (auto-lunch applies but doesn't fit
 *                the longest shift, so the company minimum is used, as on a real punch)
 * lunchSource: "department" | "shift" (per autoBreakBasis) | "company" (minimum lunch)
 */
function dayBreakdown(dayShifts, user, company) {
  const lengths = dayShifts.map((us) => ({ us, len: shiftMinutes(us) }));
  const gross = lengths.reduce((s, x) => s + x.len, 0);
  const longest = lengths.reduce((a, b) => (b.len > a.len ? b : a));

  let cfg = null;
  if (company.autoBreakBasis === "department") cfg = user.department;
  else if (company.autoBreakBasis === "shift") cfg = longest.us.shift;

  let lunch = company.minimumLunchMinutes ?? 60;
  let lunchRule = "minimum_lunch";
  let lunchSource = "company";
  if (company.autoBreakBasis && company.autoLunchEnabled && cfg?.autoLunchEntitled) {
    const after = (cfg.autoBreakLunchAfterHours ?? 4) * 60;
    const dur = cfg.autoBreakLunchMinutes ?? 60;
    // Same as applyAutoBreaks: injected only if the whole lunch fits before clock-out;
    // otherwise timeLogComputeService falls back to the minimum lunch.
    if (after + dur <= longest.len) {
      lunch = cfg.autoBreakLunchDeductible ? dur : 0;
      lunchRule = cfg.autoBreakLunchDeductible ? "auto_lunch" : "auto_lunch_not_deducted";
      lunchSource = company.autoBreakBasis;
    } else {
      lunchRule = "minimum_lunch_auto_too_short";
    }
  }

  let coffee = 0;
  if (company.autoBreakBasis && company.autoCoffeeEnabled && cfg?.autoCoffeeEntitled && cfg.autoBreakCoffeeDeductible) {
    coffee = Math.max(1, cfg.autoBreakCoffeeCount ?? 1) * (cfg.autoBreakCoffeeMinutes ?? 15);
  }

  return {
    netMinutes: Math.max(0, gross - lunch - coffee),
    grossHours: round2(gross / 60),
    lunchHours: round2(lunch / 60),
    lunchRule,
    lunchSource,
    coffeeHours: round2(coffee / 60),
    overnightShifts: dayShifts.filter(isOvernight).length,
  };
}

// ── Cutoff periods ────────────────────────────────────────────────────────────

// Same arithmetic as services/Cutoff/cutoffGenerationService.js calculatePeriodEnd.
function settingsPeriodEnd(start, frequency) {
  const m = d(start);
  if (frequency === "bi-weekly") return fmt(m.add(13, "days"));
  if (frequency === "bi-monthly") {
    if (m.date() === 1) return fmt(m.date(15));
    if (m.date() === 16) return fmt(m.endOf("month"));
    return fmt(m.add(14, "days"));
  }
  if (frequency === "monthly") return fmt(m.add(1, "month").subtract(1, "day"));
  return null;
}

function walkForward(firstStart, nextEnd, date) {
  let start = firstStart;
  for (let i = 0; i < MAX_WALK; i++) {
    const end = nextEnd(start);
    if (!end) return null;
    if (date <= end) return { start, end };
    start = addDays(end, 1);
  }
  return null;
}

async function loadCutoffContext(companyId, windowStart, windowEnd, seed) {
  const [rows, latest, settings] = await Promise.all([
    prisma.cutoffPeriod.findMany({
      where: { companyId, periodStart: { lte: new Date(`${windowEnd}T23:59:59.999Z`) }, periodEnd: { gte: new Date(`${windowStart}T00:00:00.000Z`) } },
      select: { id: true, departmentId: true, periodStart: true, periodEnd: true, status: true },
    }),
    prisma.cutoffPeriod.findMany({
      where: { companyId },
      orderBy: { periodEnd: "desc" },
      distinct: ["departmentId"],
      select: { id: true, departmentId: true, periodStart: true, periodEnd: true },
    }),
    prisma.departmentCutoffSettings.findMany({
      where: { companyId },
      select: { departmentId: true, frequency: true, startDate: true, isActive: true },
    }),
  ]);

  const keyOf = (id) => id ?? "__company__";
  const rowsByKey = new Map();
  for (const r of rows) {
    const k = keyOf(r.departmentId);
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k).push({ id: r.id, start: utcDay(r.periodStart), end: utcDay(r.periodEnd), status: r.status });
  }
  const latestByKey = new Map(latest.map((r) => [keyOf(r.departmentId), { start: utcDay(r.periodStart), end: utcDay(r.periodEnd) }]));
  const settingsByKey = new Map(settings.map((s) => [keyOf(s.departmentId), s]));

  const hasOwn = (k) => latestByKey.has(k) || settingsByKey.has(k);
  const cache = new Map();

  /** The cutoff period containing `date` for an employee in department `departmentId`. */
  function periodFor(departmentId, date) {
    const own = keyOf(departmentId);
    const k = hasOwn(own) ? own : hasOwn("__company__") ? "__company__" : null;
    const cacheKey = `${k}|${date}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    let p = null;
    if (k) {
      const hit = (rowsByKey.get(k) || []).find((r) => r.start <= date && date <= r.end);
      const last = latestByKey.get(k);
      const s = settingsByKey.get(k);
      if (hit) {
        p = { start: hit.start, end: hit.end, source: "generated", projectedFrom: null, cutoffPeriodId: hit.id, cutoffStatus: hit.status };
      } else if (last) {
        if (date > last.end && s?.isActive) {
          // Continue with the latest period's length, as the nightly job will.
          const spanDays = d(last.end).diff(d(last.start), "days");
          const w = walkForward(addDays(last.end, 1), (st) => addDays(st, spanDays), date);
          if (w) p = { ...w, source: "projected", projectedFrom: "latest_period", cutoffPeriodId: null, cutoffStatus: null };
        }
        // else: before the first period, in a gap, or settings inactive → unknown
      } else if (s?.isActive) {
        const anchor = utcDay(s.startDate);
        if (date >= anchor) {
          const w = walkForward(anchor, (st) => settingsPeriodEnd(st, s.frequency), date);
          if (w) p = { ...w, source: "projected", projectedFrom: "cutoff_settings", cutoffPeriodId: null, cutoffStatus: null };
        }
      }
    }
    if (!p && !k && seed?.seedStartDate && seed.durationDays > 0) {
      const anchor = utcDay(seed.seedStartDate);
      const n = Math.floor(d(date).diff(d(anchor), "days") / seed.durationDays);
      const start = addDays(anchor, n * seed.durationDays);
      p = { start, end: addDays(start, seed.durationDays - 1), source: "projected", projectedFrom: "company_seed", cutoffPeriodId: null, cutoffStatus: null };
    }
    cache.set(cacheKey, p);
    return p;
  }

  const anyConfig = latestByKey.size > 0 || settings.some((s) => s.isActive) || !!(seed?.seedStartDate && seed.durationDays > 0);
  return { periodFor, anyConfig };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.companyId
 * @param {string} p.from  YYYY-MM-DD
 * @param {string} p.to    YYYY-MM-DD
 * @param {string|null} p.departmentId
 */
async function buildOtProjection({ companyId, from, to, departmentId }) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      otBasis: true,
      dailyOtThresholdHours: true,
      weeklyOtThresholdHours: true,
      cutoffOtThresholdHours: true,
      minimumLunchMinutes: true,
      autoBreakBasis: true,
      autoLunchEnabled: true,
      autoCoffeeEnabled: true,
      companyCutoffSettings: { select: { seedStartDate: true, durationDays: true } },
    },
  });

  const basis = ["daily", "weekly", "cutoff"].includes(company?.otBasis) ? company.otBasis : "daily";
  const threshold =
    basis === "daily" ? parseFloat(company?.dailyOtThresholdHours ?? 8)
    : basis === "weekly" ? parseFloat(company?.weeklyOtThresholdHours ?? 40)
    : parseFloat(company?.cutoffOtThresholdHours ?? 80);

  const result = { basis, threshold, available: true, reason: null, estimate: true, employees: {} };
  if (!company) return { ...result, available: false, reason: "Company not found." };

  const users = await prisma.user.findMany({
    where: { ...HUMAN_ONLY, companyId, ...(departmentId && { departmentId }) },
    select: {
      id: true,
      departmentId: true,
      fixedHoursEnabled: true,
      department: { select: { fixedHoursEnabled: true, ...BREAK_FIELDS } },
    },
  });
  if (!users.length) return result;

  // Period of a date for one employee: { start, end, source, ... } or null (unknown).
  let periodOf;
  let expandedFrom = from;
  let expandedTo = to;

  if (basis === "daily") {
    periodOf = (_u, date) => ({ start: date, end: date, source: "calendar", projectedFrom: null, cutoffPeriodId: null, cutoffStatus: null });
  } else if (basis === "weekly") {
    periodOf = (_u, date) => ({
      start: fmt(d(date).startOf("isoWeek")),
      end: fmt(d(date).endOf("isoWeek")),
      source: "calendar", projectedFrom: null, cutoffPeriodId: null, cutoffStatus: null,
    });
    expandedFrom = fmt(d(from).startOf("isoWeek"));
    expandedTo = fmt(d(to).endOf("isoWeek"));
  } else {
    const ctx = await loadCutoffContext(companyId, addDays(from, -62), addDays(to, 62), company.companyCutoffSettings);
    if (!ctx.anyConfig)
      return { ...result, available: false, reason: "No cutoff periods or cutoff settings are set up for this company." };
    periodOf = (u, date) => ctx.periodFor(u.departmentId, date);
    for (const u of users) {
      for (const day of [from, to]) {
        const p = periodOf(u, day);
        if (p && p.start < expandedFrom) expandedFrom = p.start;
        if (p && p.end > expandedTo) expandedTo = p.end;
      }
    }
  }

  const userById = new Map(users.map((u) => [u.id, u]));
  const shifts = await prisma.userShift.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      assignedDate: { gte: new Date(`${expandedFrom}T00:00:00.000Z`), lte: new Date(`${expandedTo}T00:00:00.000Z`) },
      status: { not: "cancelled" },
    },
    select: {
      userId: true, assignedDate: true, customStartTime: true, customEndTime: true,
      shift: { select: { startTime: true, endTime: true, ...BREAK_FIELDS } },
    },
  });

  // userId → date → [userShift]
  const byUserDay = new Map();
  for (const us of shifts) {
    if (!us.shift) continue;
    const day = utcDay(us.assignedDate);
    if (!byUserDay.has(us.userId)) byUserDay.set(us.userId, new Map());
    const days = byUserDay.get(us.userId);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(us);
  }

  for (const [userId, days] of byUserDay) {
    const u = userById.get(userId);
    const fixedHours = !!(u.fixedHoursEnabled && u.department?.fixedHoursEnabled);

    const entries = [];
    let current = null;
    for (const day of [...days.keys()].sort()) {
      const b = dayBreakdown(days.get(day), u, company);
      const hours = b.netMinutes / 60;
      const p = periodOf(u, day);
      const key = p ? `${p.start}|${p.end}` : "unknown";
      // Dates of the same period form one entry; unknown dates in a row form one entry.
      if (!current || current.key !== key) {
        current = {
          key,
          periodStart: p ? p.start : day,
          periodEnd: p ? p.end : day,
          periodSource: p ? p.source : "unknown",
          projectedFrom: p ? p.projectedFrom : null,
          cutoffPeriodId: p ? p.cutoffPeriodId : null,
          cutoffStatus: p ? p.cutoffStatus : null,
          days: [],
        };
        entries.push(current);
      }
      if (!p) current.periodEnd = day;
      current.days.push({ day, hours, b });
    }

    const out = [];
    for (const e of entries) {
      if (e.periodEnd < from || e.periodStart > to) continue; // only periods overlapping the range
      const scheduled = e.days.reduce((s, x) => s + x.hours, 0);
      const known = e.periodSource !== "unknown";
      let crossesOn = null;
      if (known && !fixedHours) {
        let running = 0;
        for (const x of e.days) {
          running += x.hours;
          if (running > threshold + 1e-9) { crossesOn = x.day; break; }
        }
      }
      out.push({
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        periodSource: e.periodSource, // "calendar" | "generated" | "projected" | "unknown"
        projectedFrom: e.projectedFrom, // "latest_period" | "cutoff_settings" | "company_seed" | null
        cutoffPeriodId: e.cutoffPeriodId,
        cutoffStatus: e.cutoffStatus,
        scheduledHours: round2(scheduled),
        threshold: known ? threshold : null,
        overBy: !known ? null : fixedHours ? 0 : round2(Math.max(0, scheduled - threshold)),
        crossesOn,
        fixedHours,
        estimate: true,
        // BB-135 addendum: every scheduled date of the period (also outside from–to)
        days: e.days.map((x) => ({
          date: x.day,
          grossHours: x.b.grossHours,
          lunchHours: x.b.lunchHours,
          lunchRule: x.b.lunchRule,
          lunchSource: x.b.lunchSource,
          coffeeHours: x.b.coffeeHours,
          netHours: round2(x.hours),
          overnightShifts: x.b.overnightShifts,
        })),
      });
    }
    if (out.length) result.employees[userId] = out;
  }

  return result;
}

module.exports = { buildOtProjection };
