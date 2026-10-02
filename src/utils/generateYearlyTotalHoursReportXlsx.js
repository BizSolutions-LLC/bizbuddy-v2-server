// src/utils/generateYearlyTotalHoursReportXlsx.js
//
// BB-087: builds the "Summary" sheet of the yearly total-hours report,
// based on the column layout of docs/Sample_Yearly_Total_Hours_Report.xlsx's
// own Summary tab (Name / TOTAL Hrs / OT Hrs / per-period groups / Number of
// Months). Periods are months or quarters depending on summary.groupBy; each
// period group is always "Total Hrs", plus whichever optional columns
// (driver / regular / leave / ot / average) were requested. groupBy "year" is a
// compact layout: no per-period group (it would repeat TOTAL/OT Hrs), just
// the requested driver / regular / leave / average columns for the whole year.
// Returns a Buffer, same convention as generatePayslipPDF.js / generateCheckPDF.js.

const ExcelJS = require("exceljs");

const OPTIONAL_COLUMN_DEFS = [
  { key: "driver",  label: "Driver Total Hrs",   field: "driverHours" },
  { key: "regular", label: "Regular Total Hrs",  field: "regularHours" },
  { key: "leave",   label: "Leave Hrs",          field: "leaveHours" },
  { key: "ot",      label: "OT Hrs",             field: "otHours" },
  { key: "average", label: "Avg Hrs per Cutoff", field: "averageHours" },
];

/**
 * @param {{ year: number, groupBy: string, periodKeys: string[], employees: Array }} summary
 * @param {{ name: string }} company
 * @param {string[]} [columns] - optional per-period columns: driver, regular, leave, ot, average
 * @returns {Promise<Buffer>}
 */
async function generateYearlyTotalHoursReportXlsx(summary, company, columns = []) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");

  const isYearly = summary.groupBy === "year";
  const isQuarterly = summary.groupBy === "quarter";
  const extraColumns = OPTIONAL_COLUMN_DEFS.filter(
    (def) => columns.includes(def.key) && !(isYearly && def.key === "ot")
  );

  const headerRow = ["Name of Employee", "TOTAL Hrs", "OT Hrs"];
  if (isYearly) {
    for (const def of extraColumns) headerRow.push(def.label);
  } else {
    for (const key of summary.periodKeys) {
      headerRow.push(`${key} Total Hrs`);
      for (const def of extraColumns) headerRow.push(`${key} ${def.label}`);
    }
  }
  headerRow.push(isQuarterly ? "Number of Quarters" : "Number of Months");

  sheet.mergeCells(1, 1, 1, headerRow.length);
  sheet.getCell(1, 1).value = company?.name || "";
  sheet.getCell(1, 1).font = { bold: true, size: 14 };

  sheet.mergeCells(2, 1, 2, headerRow.length);
  sheet.getCell(2, 1).value = isYearly
    ? `TOTAL STAFF HOURS - ${summary.year} (Yearly)`
    : `TOTAL STAFF HOURS - ${summary.year} (${isQuarterly ? "Quarterly" : "Monthly"}: ${summary.periodKeys.join(", ")})`;
  sheet.getCell(2, 1).font = { bold: true, size: 12 };

  const headerRowRef = sheet.getRow(3);
  headerRowRef.values = headerRow;
  headerRowRef.font = { bold: true };
  headerRowRef.alignment = { horizontal: "center", wrapText: true };

  for (const employee of summary.employees) {
    const row = [employee.employeeName, round2(employee.totalHours), round2(employee.otHours)];
    for (const key of summary.periodKeys) {
      const p = employee.periods[key];
      if (!isYearly) row.push(round2(p.totalHours));
      for (const def of extraColumns) row.push(round2(p[def.field]));
    }
    row.push(employee.numberOfPeriods);
    sheet.addRow(row);
  }

  sheet.getColumn(1).width = 28;
  for (let col = 2; col <= headerRow.length; col++) {
    sheet.getColumn(col).width = 12;
  }

  return workbook.xlsx.writeBuffer();
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = { generateYearlyTotalHoursReportXlsx };
