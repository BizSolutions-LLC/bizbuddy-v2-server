// src/utils/generateYearlyTotalHoursReportXlsx.js
//
// BB-087: builds the "Summary" sheet of the yearly total-hours report,
// based on the column layout of docs/Sample_Yearly_Total_Hours_Report.xlsx's
// own Summary tab (Name / TOTAL Hrs / OT Hrs / per-month Total+Driver+Regular+OT
// quadruplets / Number of Months) — Driver/Regular columns per month are an
// addition beyond the sample, requested after the initial BB-087 build.
// Returns a Buffer, same convention as generatePayslipPDF.js / generateCheckPDF.js.

const ExcelJS = require("exceljs");
const { MONTH_KEYS } = require("@services/Reports/yearlyTotalHoursReportService");

/**
 * @param {{ companyId: string, year: number, employees: Array }} summary
 * @param {{ name: string }} company
 * @returns {Promise<Buffer>}
 */
async function generateYearlyTotalHoursReportXlsx(summary, company) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");

  const headerRow = ["Name of Employee", "TOTAL Hrs", "OT Hrs"];
  for (const month of MONTH_KEYS) {
    headerRow.push(
      `${month} Total Hrs`,
      `${month} Driver Total Hrs`,
      `${month} Regular Total Hrs`,
      `${month} OT Hrs`
    );
  }
  headerRow.push("Number of Months");

  sheet.mergeCells(1, 1, 1, headerRow.length);
  sheet.getCell(1, 1).value = company?.name || "";
  sheet.getCell(1, 1).font = { bold: true, size: 14 };

  sheet.mergeCells(2, 1, 2, headerRow.length);
  sheet.getCell(2, 1).value = `TOTAL STAFF HOURS - ${summary.year}`;
  sheet.getCell(2, 1).font = { bold: true, size: 12 };

  const headerRowRef = sheet.getRow(3);
  headerRowRef.values = headerRow;
  headerRowRef.font = { bold: true };
  headerRowRef.alignment = { horizontal: "center" };

  for (const employee of summary.employees) {
    const row = [employee.employeeName, round2(employee.totalHours), round2(employee.otHours)];
    for (const month of MONTH_KEYS) {
      const m = employee.months[month];
      row.push(round2(m.totalHours), round2(m.driverHours), round2(m.regularHours), round2(m.otHours));
    }
    row.push(employee.numberOfMonths);
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
