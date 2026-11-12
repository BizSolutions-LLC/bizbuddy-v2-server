// src/utils/generatePayrollGridXlsx.js
//
// BB-119: the company Punch Logs "Payroll Grid" as an Excel workbook on the shared
// template (utils/xlsx/reportWorkbook.js). Same figures as the CSV version
// (services/Reports/punchLogPayrollGrid.js) and the same core idea: one column
// group per DATE with that day's Driver Aide AM / Regular / Driver Aide PM hours,
// then the totals (AM, Regular, PM, Driving, TR, SL, OT, Total).
//
// Layout (row 8 onward, under the title block):
//   row 8  ID | Name of Employee | Role | <Mon 10-14> (merged ×3) … | Total Hours (merged ×3) | Driving Hrs | TR | SL | OT | Total
//   row 9            (merged down)      | AM | Regular | PM …       | AM | Regular | PM         |  (merged down)
//   one row per employee, then Total. Hours are numbers (0.00); empty when 0.
//   Saturday/Sunday date groups are tinted; ID / name / role and both header rows are frozen.

const moment = require("moment-timezone");
const XL = require("@utils/xlsx/reportWorkbook");

const { style } = XL;
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const num = (v) => (v > 0 ? Math.round(v * 100) / 100 : null);
const WEEKEND = "FFF3F4F6";

/**
 * @param {object} grid  from buildPayrollGrid
 * @returns {Promise<Buffer>}
 */
function generatePayrollGridXlsx(grid) {
  const { report, dates, employees, grand } = grid;
  const { company, requester, filters, basis } = report;
  const tz = company.timeZone;

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Payroll Grid",
    tag: "client",
    requester,
    generatedLabel: report.generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: tz,
  });

  const LEAD = 3; // ID, Name, Role
  const firstDateCol = LEAD + 1;
  const totalsCol = firstDateCol + dates.length * 3; // Total Hours AM
  const TOTAL_KEYS = ["am", "regular", "pm", "driving", "training", "sick", "overtime", "total"];
  const lastCol = totalsCol + TOTAL_KEYS.length - 1;
  const basisLabel = { final: "Final", preliminary: "Preliminary", partial: "Partly final" }[basis];

  const widths = [10, 24, 18];
  for (let i = 0; i < dates.length * 3; i++) widths.push(7.5);
  widths.push(9, 9, 9, 9, 7.5, 7.5, 7.5, 9);

  const { ws, startRow } = XL.addCustomSheet(book, {
    name: "Payroll Grid",
    title: "Payroll Grid",
    subtitle: `${filters.rangeLabel} · ${plural(employees.length, "employee")} · ${basisLabel} · ${filters.punchLabel}`,
    lastCol: Math.min(lastCol, LEAD + 12), // keep the title block on the first screen
    freezeRows: 2,
    freezeColumns: LEAD,
    widths,
  });

  const r1 = startRow;
  const r2 = startRow + 1;
  const isWeekend = (ymd) => [0, 6].includes(moment.utc(ymd).day());

  // ── Header rows ──
  const lead = ["ID", "Name of Employee", "Role"];
  lead.forEach((label, i) => {
    ws.mergeCells(r1, i + 1, r2, i + 1);
    const c = ws.getCell(r1, i + 1);
    c.value = label;
    style.header(c, { align: i === 0 ? "center" : "left" });
  });
  dates.forEach((ymd, d) => {
    const col = firstDateCol + d * 3;
    ws.mergeCells(r1, col, r1, col + 2);
    const c = ws.getCell(r1, col);
    c.value = moment.utc(ymd).format("ddd MM-DD");
    style.header(c);
    ["AM", "Regular", "PM"].forEach((label, k) => {
      const s = ws.getCell(r2, col + k);
      s.value = label;
      style.subHeader(s);
      if (isWeekend(ymd)) s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6D7BC" } };
    });
    style.groupEdge(ws.getCell(r2, col));
  });
  ws.mergeCells(r1, totalsCol, r1, totalsCol + 2);
  ws.getCell(r1, totalsCol).value = "Total Hours";
  style.header(ws.getCell(r1, totalsCol));
  ["Driver Aide AM", "Regular", "Driver Aide PM"].forEach((label, k) => {
    const s = ws.getCell(r2, totalsCol + k);
    s.value = label;
    style.subHeader(s);
  });
  style.groupEdge(ws.getCell(r2, totalsCol));
  [["Driving Hrs", "AM + PM"], ["TR"], ["SL"], ["OT"], ["Total"]].forEach(([label, sub], k) => {
    const col = totalsCol + 3 + k;
    if (sub) {
      ws.getCell(r1, col).value = label;
      style.header(ws.getCell(r1, col));
      ws.getCell(r2, col).value = sub;
      style.subHeader(ws.getCell(r2, col));
    } else {
      ws.mergeCells(r1, col, r2, col);
      ws.getCell(r1, col).value = label;
      style.header(ws.getCell(r1, col));
    }
  });
  ws.getRow(r1).height = 20;
  ws.getRow(r2).height = 26;

  // ── Employee rows ──
  let row = r2 + 1;
  employees.forEach((e, index) => {
    const striped = index % 2 === 1;
    const lead3 = [e.employeeId, e.name, e.role];
    lead3.forEach((v, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = v || null;
      style.body(c, { striped });
      if (i === 0) c.alignment = { vertical: "middle", horizontal: "center" };
    });
    e.days.forEach((day, d) => {
      const col = firstDateCol + d * 3;
      [day?.am, day?.regular, day?.pm].forEach((v, k) => {
        const c = ws.getCell(row, col + k);
        c.value = num(v || 0);
        style.body(c, { striped, numeric: true });
        if (isWeekend(dates[d]) && !striped) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: WEEKEND } };
      });
      style.groupEdge(ws.getCell(row, col));
    });
    TOTAL_KEYS.forEach((key, k) => {
      const c = ws.getCell(row, totalsCol + k);
      c.value = num(e.totals[key]);
      style.body(c, { striped, numeric: true });
      if (key === "total") c.font = { ...c.font, bold: true };
    });
    style.groupEdge(ws.getCell(row, totalsCol));
    row += 1;
  });

  // ── Total row ──
  for (let col = 1; col <= lastCol; col++) style.total(ws.getCell(row, col));
  ws.getCell(row, 2).value = "Total";
  TOTAL_KEYS.forEach((key, k) => {
    const c = ws.getCell(row, totalsCol + k);
    c.value = num(grand[key]);
    style.total(c, { numeric: true });
  });
  row += 2;

  // ── Legend and notes ──
  const noteCols = Math.min(lastCol, LEAD + 12);
  [
    "TR - Training · SL - Sick Leave · OT - Overtime. Driving Hrs = Driver Aide AM + PM. Training hours show under Regular on each day and in TR in the totals.",
    `Dates are in ${tz} (the company's time zone). ${basis === "preliminary" ? "Live punches: hours can still change in cutoff review." : "Locked or processed cutoffs show the reviewed, paid hours."}`,
    "Fixed-hours employees (marked \"(fixed hours)\"): Regular = their fixed hours minus sick leave; daily cells show the hours worked, capped at one shift; Total adds their approved off-day overtime.",
    "SL is approved, paid sick leave in the range (on locked cutoffs, leave days with no punch). OT is the approved overtime recorded in cutoff review.",
  ].forEach((t) => {
    style.note(ws, row, noteCols, t);
    row += 1;
  });
  style.footer(ws, row + 1, noteCols, book);

  return XL.finish(book);
}

module.exports = { generatePayrollGridXlsx };
