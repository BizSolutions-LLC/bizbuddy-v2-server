// src/utils/generateLeaveReportXlsx.js
//
// BB-106 (design redone for BB-119): renders buildLeaveTemplateReport() into the
// docs/LeaveReport_Template.csv layout, one worksheet per leave type, on the shared
// Excel template (utils/xlsx/reportWorkbook.js): title block, watermark, print
// header/footer. The template's columns, wording and figures are unchanged.
//
// Layout (row 8 onward, under the title block):
//   row 8  # | NAME | DOH | Beginning Balance Y-1 | Total Used Y-1 | Balance Y-1 | Credits | Beginning Balance Y | JAN (merged over its pay dates) … | Total Used Y | Balance Y | Beginning Balance Y+1
//   row 9          (merged down)                                          |   Y     |      (merged down)      |  9  | 23 …                  |          (merged down)
//   one row per employee ("Last, First"), then TOTAL HOURS. Zeros print as "-", like
//   the template; pay-date cells are empty when no leave was used.

const moment = require("moment-timezone");
const XL = require("@utils/xlsx/reportWorkbook");
const { MONTH_KEYS, QUARTER_KEYS } = require("@services/Reports/leaveTemplateReportService");

const { style, keysLabel } = XL;

// Accounting-style: zero prints as "-", like the template.
const NUM_FMT = '#,##0.00;-#,##0.00;"-"';
const MONTH_LABELS = MONTH_KEYS.map((m) => m.toUpperCase());
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

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

// "Year 2026 · Months included: Jan – Jun · Department: All departments · 18 employees"
function settingsLine(report, employees) {
  const included =
    report.groupBy === "year"
      ? "Whole year"
      : report.groupBy === "quarter"
        ? `Quarters included: ${keysLabel(report.periods, QUARTER_KEYS)}`
        : `Months included: ${keysLabel(report.periods, MONTH_KEYS)}`;
  return [
    `Year ${report.year}`,
    included,
    `Department: ${report.departmentName || "All departments"}`,
    employees == null ? null : plural(employees, "employee"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function notes(report) {
  const Y = report.year;
  return [
    report.columnSource === "calendar"
      ? `No cutoffs are paid in ${Y}, so the columns are calendar months (the last day of each month) instead of pay dates.`
      : "Each column is a cutoff pay date. A leave day counts in the cutoff that contains it.",
    report.groupBy === "year"
      ? `Balance ${Y} is as of the last cutoff of the year.`
      : `Balance ${Y} is as of the end of the last selected cutoff; Total Used ${Y} covers the selected ${report.groupBy === "quarter" ? "quarters" : "months"} only.`,
    `Beginning Balance ${Y} = Balance ${Y - 1}. Beginning Balance ${Y + 1} = Balance ${Y} + the ${Y + 1} grant. Credits ${Y} are the hours granted in ${Y}.`,
    `Hours, by leave date, in ${report.company.timezone} (the company's time zone). DOH = date of hire. "-" means zero.`,
  ];
}

function addLeaveSheet(book, name, report, sheet) {
  const Y = report.year;
  const cols = report.columns;

  // Column positions (1-based).
  const C = { no: 1, name: 2, doh: 3, prevBeg: 4, prevUsed: 5, prevBal: 6, credits: 7, beg: 8 };
  const firstPay = 9;
  const totalUsedCol = firstPay + cols.length;
  const balanceCol = totalUsedCol + 1;
  const nextBegCol = totalUsedCol + 2;
  const lastCol = nextBegCol;
  const LEAD = 3;

  const widths = [5, 26, 11, 11, 10, 10, 9, 11];
  cols.forEach(() => widths.push(7));
  widths.push(10, 10, 11);

  const { ws, startRow } = XL.addCustomSheet(book, {
    name,
    title: `Leave Report — ${sheet.leaveType}${sheet.isArchived ? " (archived)" : ""}`,
    subtitle: settingsLine(report, sheet.rows.length),
    lastCol: Math.min(lastCol, firstPay + 7),
    freezeRows: 2,
    freezeColumns: LEAD,
    widths,
  });
  const r1 = startRow;
  const r2 = startRow + 1;

  const mergedHeader = (col, label, align = "center") => {
    ws.mergeCells(r1, col, r2, col);
    const c = ws.getCell(r1, col);
    c.value = label;
    style.header(c, { align });
  };

  // ── Header rows (template wording) ──
  mergedHeader(C.no, "#");
  mergedHeader(C.name, "NAME", "left");
  mergedHeader(C.doh, "DOH");
  mergedHeader(C.prevBeg, `Beginning Balance ${Y - 1}`);
  mergedHeader(C.prevUsed, `Total Used ${Y - 1}`);
  mergedHeader(C.prevBal, `Balance ${Y - 1}`);
  ws.getCell(r1, C.credits).value = "Credits";
  style.header(ws.getCell(r1, C.credits));
  ws.getCell(r2, C.credits).value = `${Y}`;
  style.subHeader(ws.getCell(r2, C.credits));
  mergedHeader(C.beg, `Beginning Balance ${Y}`);

  // Month header spans its pay-date columns; the pay day sits under it.
  const groupStarts = [];
  let i = 0;
  while (i < cols.length) {
    let j = i;
    while (
      j + 1 < cols.length &&
      cols[j + 1].month === cols[i].month &&
      cols[j + 1].paymentDate.slice(0, 4) === cols[i].paymentDate.slice(0, 4)
    ) j++;
    if (j > i) ws.mergeCells(r1, firstPay + i, r1, firstPay + j);
    const c = ws.getCell(r1, firstPay + i);
    c.value = MONTH_LABELS[cols[i].month];
    style.header(c);
    groupStarts.push(firstPay + i);
    i = j + 1;
  }
  cols.forEach((c, k) => {
    const s = ws.getCell(r2, firstPay + k);
    s.value = c.day;
    style.subHeader(s);
  });
  groupStarts.forEach((col) => style.groupEdge(ws.getCell(r2, col)));

  mergedHeader(totalUsedCol, `Total Used ${Y}`);
  mergedHeader(balanceCol, `Balance ${Y}`);
  mergedHeader(nextBegCol, `Beginning Balance ${Y + 1}`);
  ws.getRow(r1).height = 30;
  ws.getRow(r2).height = 16;

  // ── Employee rows ──
  const setNum = (row, col, v, { striped, blankZero = false, total = false } = {}) => {
    const c = ws.getCell(row, col);
    c.value = blankZero && !v ? null : v ?? 0;
    if (total) style.total(c, { numeric: true });
    else style.body(c, { striped, numeric: true });
    c.numFmt = NUM_FMT;
  };

  let row = r2 + 1;
  sheet.rows.forEach((r, idx) => {
    const striped = idx % 2 === 1;
    const no = ws.getCell(row, C.no);
    no.value = idx + 1;
    style.body(no, { striped });
    no.alignment = { vertical: "middle", horizontal: "center" };

    const nm = ws.getCell(row, C.name);
    nm.value = r.employee.name || null;
    style.body(nm, { striped });

    const doh = ws.getCell(row, C.doh);
    doh.value = XL.wallClock(r.employee.hireDate);
    style.body(doh, { striped });
    doh.numFmt = XL.FMT.date;
    doh.alignment = { vertical: "middle", horizontal: "center" };

    setNum(row, C.prevBeg, r.prevBeg, { striped });
    setNum(row, C.prevUsed, r.prevUsed, { striped });
    setNum(row, C.prevBal, r.prevBal, { striped });
    setNum(row, C.credits, r.credits, { striped });
    setNum(row, C.beg, r.beg, { striped });
    r.cells.forEach((h, k) => setNum(row, firstPay + k, h, { striped, blankZero: true })); // empty, like the template
    setNum(row, totalUsedCol, r.totalUsed, { striped });
    setNum(row, balanceCol, r.balance, { striped });
    setNum(row, nextBegCol, r.nextBeg, { striped });
    ws.getCell(row, balanceCol).font = { ...ws.getCell(row, balanceCol).font, bold: true };
    groupStarts.forEach((col) => style.groupEdge(ws.getCell(row, col)));
    row += 1;
  });

  // ── TOTAL HOURS row ──
  const t = sheet.totals;
  for (let col = 1; col <= lastCol; col++) style.total(ws.getCell(row, col));
  ws.getCell(row, C.name).value = "TOTAL HOURS";
  setNum(row, C.prevBeg, t.prevBeg, { total: true });
  setNum(row, C.prevUsed, t.prevUsed, { total: true });
  setNum(row, C.prevBal, t.prevBal, { total: true });
  setNum(row, C.credits, t.credits, { total: true });
  setNum(row, C.beg, t.beg, { total: true });
  t.cells.forEach((h, k) => setNum(row, firstPay + k, h, { total: true }));
  setNum(row, totalUsedCol, t.totalUsed, { total: true });
  setNum(row, balanceCol, t.balance, { total: true });
  setNum(row, nextBegCol, t.nextBeg, { total: true });
  row += 2;

  // ── Notes and footer ──
  const noteCols = Math.min(lastCol, firstPay + 7);
  notes(report).forEach((text) => {
    style.note(ws, row, noteCols, text);
    row += 1;
  });
  style.footer(ws, row + 1, noteCols, book);
}

/**
 * @param {object} report  buildLeaveTemplateReport() result
 * @returns {Promise<Buffer>}
 */
function generateLeaveReportXlsx(report) {
  const tz = report.company.timezone;
  const book = XL.createWorkbook({
    company: report.company.name,
    reportName: "Leave Report",
    tag: "client",
    requester: report.requester,
    generatedLabel: moment(report.generatedAt).tz(tz).format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });

  if (!report.sheets.length) {
    const { ws, startRow } = XL.addCustomSheet(book, {
      name: "Leave Report",
      title: "Leave Report",
      subtitle: settingsLine(report, null),
      lastCol: 8,
      widths: [5, 26, 11, 11, 10, 10, 9, 11],
    });
    style.note(ws, startRow, 8, "No employees or leave types match the selected filters.");
    style.footer(ws, startRow + 2, 8, book);
    return XL.finish(book);
  }

  const used = new Set();
  for (const sheet of report.sheets) addLeaveSheet(book, sheetName(sheet.leaveType, used), report, sheet);
  return XL.finish(book);
}

module.exports = { generateLeaveReportXlsx };
