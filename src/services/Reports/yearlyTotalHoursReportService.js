// src/services/Reports/yearlyTotalHoursReportService.js
//
// BB-087: aggregates the already-computed PayrollExport rows (per-employee,
// per-cutoff-period, written by payrollExportService.js — see BB-066) into a
// yearly per-employee Summary, replacing the manual VLOOKUP-built "TOTAL
// STAFF HOURS" workbook this ticket is modeled on
// (docs/Sample_Yearly_Total_Hours_Report.xlsx).
//
// PayrollExport is queried via $queryRaw for the same reason
// payrollExportService.js writes to it that way — it predates being modeled
// in schema.prisma and the raw-SQL convention was kept for consistency.

const { prisma } = require("@config/connection");

const MONTH_KEYS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const QUARTER_KEYS = ["Q1", "Q2", "Q3", "Q4"];

const YEAR_KEYS = ["Year"];

const GROUP_BY_KEYS = { month: MONTH_KEYS, quarter: QUARTER_KEYS, year: YEAR_KEYS };

const OPTIONAL_COLUMNS = ["driver", "regular", "ot", "average"];

function n(v) {
  return v == null ? 0 : parseFloat(v.toString());
}

function periodKeyFor(periodEnd, groupBy) {
  const month = new Date(periodEnd).getUTCMonth();
  if (groupBy === "year") return YEAR_KEYS[0];
  return groupBy === "quarter" ? QUARTER_KEYS[Math.floor(month / 3)] : MONTH_KEYS[month];
}

function formatName(profile, fallback) {
  const first = (profile?.firstName || "").trim();
  const last = (profile?.lastName || "").trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || fallback || "";
}

/**
 * @param {string} companyId
 * @param {number} year - calendar year, e.g. 2024
 * @param {{ groupBy?: "month"|"quarter"|"year", periods?: string[] }} [options]
 *   periods — which month/quarter keys to include; defaults to all of groupBy's keys.
 *   Ignored for groupBy "year", which is always the single "Year" key.
 * @returns {Promise<{ companyId: string, year: number, groupBy: string, periodKeys: string[], employees: Array }>}
 */
async function getYearlyTotalHoursSummary(companyId, year, options = {}) {
  const groupBy = GROUP_BY_KEYS[options.groupBy] ? options.groupBy : "month";
  const allKeys = GROUP_BY_KEYS[groupBy];
  const periodKeys = groupBy !== "year" && options.periods?.length
    ? allKeys.filter((key) => options.periods.includes(key))
    : allKeys;

  // Each cutoff period is bucketed whole into the month of its periodEnd —
  // the last day of the cutoff — e.g. Jun 10–23 → June, Jun 24–Jul 7 → July.
  // Quarters are derived from that same month, and "year" is simply every
  // cutoff whose periodEnd falls in the year (Dec 24–Jan 6 counts toward the
  // following year) — days are never split by calendar month or year.
  const rows = await prisma.$queryRaw`
    SELECT "userId", "employeeId", "employeeName", "periodStart", "periodEnd",
           "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
    FROM "PayrollExport"
    WHERE "companyId" = ${companyId}
      AND "periodEnd" >= ${`${year}-01-01`}::date
      AND "periodEnd" <= ${`${year}-12-31`}::date
  `;

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const profiles = userIds.length
    ? await prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, firstName: true, lastName: true },
      })
    : [];
  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

  const byUser = new Map();
  function getBucket(row) {
    if (!byUser.has(row.userId)) {
      byUser.set(row.userId, {
        userId: row.userId,
        employeeId: row.employeeId || null,
        employeeName: formatName(profileByUser.get(row.userId), row.employeeName),
        totalHours: 0,
        otHours: 0,
        // months with any hours, by periodEnd month — for "Number of Months" in yearly mode
        activeMonths: new Set(),
        periods: periodKeys.reduce((acc, key) => {
          // cutoffKeys — distinct cutoff periods in this bucket, for the average;
          // a user can have one row per department for the same cutoff.
          acc[key] = { totalHours: 0, driverHours: 0, regularHours: 0, otHours: 0, cutoffKeys: new Set() };
          return acc;
        }, {}),
      });
    }
    return byUser.get(row.userId);
  }

  for (const row of rows) {
    const periodKey = periodKeyFor(row.periodEnd, groupBy);
    if (!periodKeys.includes(periodKey)) continue;

    const bucket = getBucket(row);
    const p = bucket.periods[periodKey];

    const total = n(row.regularHours) + n(row.driverHours) + n(row.trainingHours) + n(row.ptoHours);
    const ot = n(row.otHours);

    // Yearly TOTAL/OT cover only the included months/quarters.
    bucket.totalHours += total;
    bucket.otHours += ot;
    p.totalHours += total;
    p.driverHours += n(row.driverHours);
    p.regularHours += n(row.regularHours);
    p.otHours += ot;
    if (total > 0) bucket.activeMonths.add(new Date(row.periodEnd).getUTCMonth());
    p.cutoffKeys.add(`${new Date(row.periodStart).toISOString()}|${new Date(row.periodEnd).toISOString()}`);
  }

  const employees = Array.from(byUser.values())
    .map((b) => {
      const periods = {};
      for (const key of periodKeys) {
        const { cutoffKeys, ...p } = b.periods[key];
        periods[key] = {
          ...p,
          cutoffCount: cutoffKeys.size,
          averageHours: cutoffKeys.size ? p.totalHours / cutoffKeys.size : 0,
        };
      }
      const { activeMonths, ...rest } = b;
      return {
        ...rest,
        periods,
        numberOfPeriods: groupBy === "year"
          ? activeMonths.size
          : periodKeys.filter((key) => periods[key].totalHours > 0).length,
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { companyId, year, groupBy, periodKeys, employees };
}

module.exports = { getYearlyTotalHoursSummary, MONTH_KEYS, QUARTER_KEYS, GROUP_BY_KEYS, OPTIONAL_COLUMNS };
