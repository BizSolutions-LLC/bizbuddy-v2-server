// src/utils/generateLeaveReportXlsx.js
//
// BB-106: renders buildLeaveTemplateReport() into the docs/LeaveReport_Template.csv
// layout, one worksheet per leave type. Returns a Buffer, the same convention as
// generateYearlyTotalHoursReportXlsx.js.

const ExcelJS = require("exceljs");
const { MONTH_KEYS } = require("@services/Reports/leaveTemplateReportService");

// Accounting-style: zero prints as "-", like the template.
const NUM_FMT = '#,##0.00;-#,##0.00;"-"';
const MONTH_LABELS = MONTH_KEYS.map((m) => m.toUpperCase());
const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };

const mmddyy = (ymd) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(2, 4)}` : "");

function sheetName(leaveType, used) {
  const base = (String(leaveType || "Leave").replace(/[\\/*?:[\]]/g, " ").trim() || "Leave").slice(0, 31);
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function rangeLabel(report) {
  if (report.groupBy === "year") return `${report.year}`;
  return `${report.year} (${report.periods.join(", ")})`;
}

function addSheet(workbook, name, report, sheet) {
  const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", xSplit: 3, ySplit: 4 }] });
  const Y = report.year;
  const cols = report.columns;

  // Column positions (1-based).
  const C = { no: 1, name: 2, doh: 3, prevBeg: 4, prevUsed: 5, prevBal: 6, credits: 7, beg: 8 };
  const firstPay = 9;
  const totalUsedCol = firstPay + cols.length;
  const balanceCol = totalUsedCol + 1;
  const nextBegCol = totalUsedCol + 2;
  const lastCol = nextBegCol;

  // Title rows.
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = report.company.name || "";
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value =
    `LEAVE REPORT — ${sheet.leaveType}${sheet.isArchived ? " (archived)" : ""} — ${rangeLabel(report)}` +
    (report.columnSource === "calendar" ? "  ·  no cutoffs for this year, columns are calendar months" : "");
  ws.getCell(2, 1).font = { bold: true, size: 12 };

  // Header row 3 (labels / month names) and row 4 (year / pay-date day).
  const h1 = ws.getRow(3);
  const h2 = ws.getRow(4);
  const set = (row, col, v) => { row.getCell(col).value = v; };
  set(h1, C.name, "NAME");
  set(h1, C.doh, "DOH");
  set(h1, C.prevBeg, `Beginning Balance ${Y - 1}`);
  set(h1, C.prevUsed, `Total Used ${Y - 1}`);
  set(h1, C.prevBal, `Balance ${Y - 1}`);
  set(h1, C.credits, "Credits");
  set(h2, C.credits, `${Y}`);
  set(h1, C.beg, `Beginning Balance ${Y}`);
  set(h1, totalUsedCol, `Total Used ${Y}`);
  set(h1, balanceCol, `Balance ${Y}`);
  set(h1, nextBegCol, `Beginning Balance ${Y + 1}`);

  // Month header spans its pay-date columns.
  let i = 0;
  while (i < cols.length) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1].month === cols[i].month && cols[j + 1].paymentDate.slice(0, 4) === cols[i].paymentDate.slice(0, 4)) j++;
    if (j > i) ws.mergeCells(3, firstPay + i, 3, firstPay + j);
    set(h1, firstPay + i, MONTH_LABELS[cols[i].month]);
    i = j + 1;
  }
  cols.forEach((c, k) => set(h2, firstPay + k, c.day));

  for (const r of [h1, h2]) {
    r.font = { bold: true };
    r.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
  h1.height = 32;

  // Employee rows.
  sheet.rows.forEach((r, idx) => {
    const values = [];
    values[C.no] = idx + 1;
    values[C.name] = r.employee.name;
    values[C.doh] = mmddyy(r.employee.hireDate);
    values[C.prevBeg] = r.prevBeg;
    values[C.prevUsed] = r.prevUsed;
    values[C.prevBal] = r.prevBal;
    values[C.credits] = r.credits;
    values[C.beg] = r.beg;
    r.cells.forEach((h, k) => { values[firstPay + k] = h ? h : null; }); // empty, like the template
    values[totalUsedCol] = r.totalUsed;
    values[balanceCol] = r.balance;
    values[nextBegCol] = r.nextBeg;
    ws.addRow(values);
  });

  // TOTAL HOURS row.
  const t = sheet.totals;
  const tv = [];
  tv[C.name] = "TOTAL HOURS";
  tv[C.prevBeg] = t.prevBeg;
  tv[C.prevUsed] = t.prevUsed;
  tv[C.prevBal] = t.prevBal;
  tv[C.credits] = t.credits;
  tv[C.beg] = t.beg;
  t.cells.forEach((h, k) => { tv[firstPay + k] = h; });
  tv[totalUsedCol] = t.totalUsed;
  tv[balanceCol] = t.balance;
  tv[nextBegCol] = t.nextBeg;
  const totalRow = ws.addRow(tv);
  totalRow.font = { bold: true };

  // Formats, widths, borders.
  ws.getColumn(C.no).width = 5;
  ws.getColumn(C.name).width = 28;
  ws.getColumn(C.doh).width = 10;
  for (let col = C.prevBeg; col <= lastCol; col++) {
    const isPay = col >= firstPay && col < totalUsedCol;
    ws.getColumn(col).width = isPay ? 7 : 12;
  }
  for (let rowNo = 3; rowNo <= ws.rowCount; rowNo++) {
    for (let col = 1; col <= lastCol; col++) {
      const cell = ws.getCell(rowNo, col);
      cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
      // Hours format on data + total rows only (row 4 holds plain day numbers).
      if (rowNo >= 5 && col >= C.prevBeg) cell.numFmt = NUM_FMT;
    }
  }
  ws.getColumn(C.doh).alignment = { horizontal: "center" };
}

/**
 * @param {object} report  buildLeaveTemplateReport() result
 * @returns {Promise<Buffer>}
 */
async function generateLeaveReportXlsx(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(report.generatedAt);

  if (!report.sheets.length) {
    const ws = workbook.addWorksheet("Leave Report");
    ws.getCell(1, 1).value = report.company.name || "";
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.getCell(2, 1).value = `LEAVE REPORT — ${rangeLabel(report)}`;
    ws.getCell(3, 1).value = "No employees or leave types match the selected filters.";
    return workbook.xlsx.writeBuffer();
  }

  const used = new Set();
  for (const sheet of report.sheets) addSheet(workbook, sheetName(sheet.leaveType, used), report, sheet);
  return workbook.xlsx.writeBuffer();
}

module.exports = { generateLeaveReportXlsx };
