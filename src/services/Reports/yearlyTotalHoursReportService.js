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

function n(v) {
  return v == null ? 0 : parseFloat(v.toString());
}

/**
 * @param {string} companyId
 * @param {number} year - calendar year, e.g. 2024
 * @returns {Promise<{ companyId: string, year: number, employees: Array }>}
 */
async function getYearlyTotalHoursSummary(companyId, year) {
  // Bucketed by periodEnd — the period a row was paid out for — so a period
  // straddling a month/year boundary lands in the month it was closed in,
  // consistent with how PayrollExport rows are already keyed.
  const rows = await prisma.$queryRaw`
    SELECT "userId", "employeeId", "employeeName", "periodEnd",
           "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
    FROM "PayrollExport"
    WHERE "companyId" = ${companyId}
      AND "periodEnd" >= ${`${year}-01-01`}::date
      AND "periodEnd" <= ${`${year}-12-31`}::date
  `;

  const byUser = new Map();
  function getBucket(row) {
    if (!byUser.has(row.userId)) {
      byUser.set(row.userId, {
        userId: row.userId,
        employeeId: row.employeeId || null,
        employeeName: row.employeeName,
        totalHours: 0,
        otHours: 0,
        months: MONTH_KEYS.reduce((acc, key) => {
          acc[key] = { totalHours: 0, driverHours: 0, regularHours: 0, otHours: 0 };
          return acc;
        }, {}),
      });
    }
    return byUser.get(row.userId);
  }

  for (const row of rows) {
    const bucket = getBucket(row);
    const monthKey = MONTH_KEYS[new Date(row.periodEnd).getUTCMonth()];

    const total = n(row.regularHours) + n(row.driverHours) + n(row.trainingHours) + n(row.ptoHours);
    const driver = n(row.driverHours);
    const regular = n(row.regularHours);
    const ot = n(row.otHours);

    bucket.totalHours += total;
    bucket.otHours += ot;
    bucket.months[monthKey].totalHours += total;
    bucket.months[monthKey].driverHours += driver;
    bucket.months[monthKey].regularHours += regular;
    bucket.months[monthKey].otHours += ot;
  }

  const employees = Array.from(byUser.values())
    .map((b) => ({
      ...b,
      numberOfMonths: MONTH_KEYS.filter((key) => b.months[key].totalHours > 0).length,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { companyId, year, employees };
}

module.exports = { getYearlyTotalHoursSummary, MONTH_KEYS };
