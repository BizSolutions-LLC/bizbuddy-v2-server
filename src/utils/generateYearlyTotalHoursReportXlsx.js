// src/utils/generateYearlyTotalHoursReportXlsx.js
//
// BB-087 (layout redone for BB-119): the yearly total-hours Summary workbook on
// the shared Excel template (utils/xlsx/reportWorkbook.js). Same figures as
// before (services/Reports/yearlyTotalHoursReportService.js, from PayrollExport);
// only the presentation changed.
//
// Layout (row 8 onward, under the title block):
//   row 8  Name of Employee | Total Hrs | OT Hrs | <Jan> (merged over its columns) … | Number of Months
//   row 9      (merged down)                    | Total | Driver | Regular | Leave | OT | Avg / cutoff …
//   one row per employee ("Last, First"), then a bold Total row. Hours are 0.00, empty when 0.
// groupBy "year" is compact: no period groups, just the requested columns for the
// whole year (OT is already a main column), each merged down.
// The subtitle carries the report settings: year, grouped by, months/quarters included,
// extra columns and the employee count.

const XL = require("@utils/xlsx/reportWorkbook");

const { style, keysLabel } = XL;

const OPTIONAL_COLUMN_DEFS = [
  { key: "driver",  label: "Driver",        long: "Driver Hrs",          field: "driverHours" },
  { key: "regular", label: "Regular",       long: "Regular Hrs",         field: "regularHours" },
  { key: "leave",   label: "Leave",         long: "Leave Hrs",           field: "leaveHours" },
  { key: "ot",      label: "OT",            long: "OT Hrs",              field: "otHours" },
  { key: "average", label: "Avg / cutoff",  long: "Avg Hrs per Cutoff",  field: "averageHours" },
];
const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL_QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const MONTH_NAMES = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December",
};

const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const num = (v) => (v > 0 ? Math.round(v * 100) / 100 : null);

/**
 * @param {{ year: number, groupBy: string, periodKeys: string[], employees: Array }} summary
 * @param {{ company: { name: string, timeZone: string }, requester: object, generatedAt: import("moment").Moment }} ctx
 * @param {string[]} [columns] optional per-period columns: driver, regular, leave, ot, average
 * @returns {Promise<Buffer>}
 */
function generateYearlyTotalHoursReportXlsx(summary, ctx, columns = []) {
  const { company, requester, generatedAt } = ctx;
  const { year, groupBy, periodKeys, employees } = summary;
  const isYearly = groupBy === "year";
  const isQuarterly = groupBy === "quarter";
  const extras = OPTIONAL_COLUMN_DEFS.filter((d) => columns.includes(d.key) && !(isYearly && d.key === "ot"));

  const book = XL.createWorkbook({
    company: company.name,
    reportName: "Yearly Total Hours",
    tag: "client",
    requester,
    generatedLabel: generatedAt.format("MMM D, YYYY, h:mm A z"),
    timeZone: company.timeZone,
  });

  // ── Report settings, shown in the subtitle ──
  const groupedBy = isYearly ? "Whole year" : isQuarterly ? "Quarter" : "Month";
  const included = isYearly
    ? null
    : isQuarterly
      ? `Quarters included: ${keysLabel(periodKeys, ALL_QUARTERS)}`
      : `Months included: ${keysLabel(periodKeys, ALL_MONTHS)}`;
  const extraLabel = extras.length ? `Columns: Total, ${extras.map((d) => d.label).join(", ")}` : "Columns: Total only";
  const subtitle = [`Year ${year}`, `Grouped by: ${groupedBy}`, included, extraLabel, plural(employees.length, "employee")]
    .filter(Boolean)
    .join(" · ");

  // ── Column plan ──
  // lead: Name, Total Hrs, OT Hrs. Then per-period groups (or the yearly extras), then the count.
  const LEAD = 3;
  const groupWidth = 1 + extras.length; // Total + extras per period
  const firstGroupCol = LEAD + 1;
  const bodyCols = isYearly ? extras.length : periodKeys.length * groupWidth;
  const countCol = firstGroupCol + bodyCols;
  const lastCol = countCol;
  const countLabel = isQuarterly ? "Number of Quarters" : "Number of Months";

  const widths = [26, 10, 9];
  for (let i = 0; i < bodyCols; i++) widths.push(isYearly ? 11 : 9);
  widths.push(10);

  const { ws, startRow } = XL.addCustomSheet(book, {
    name: "Summary",
    title: `Yearly Total Hours — ${year}`,
    subtitle,
    lastCol: Math.min(lastCol, LEAD + 12),
    freezeRows: 2,
    freezeColumns: 1,
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

  // ── Header rows ──
  mergedHeader(1, "Name of Employee", "left");
  mergedHeader(2, "Total Hrs");
  mergedHeader(3, "OT Hrs");
  if (isYearly) {
    extras.forEach((d, k) => mergedHeader(firstGroupCol + k, d.long));
  } else {
    periodKeys.forEach((key, p) => {
      const col = firstGroupCol + p * groupWidth;
      if (groupWidth > 1) ws.mergeCells(r1, col, r1, col + groupWidth - 1);
      const c = ws.getCell(r1, col);
      c.value = isQuarterly ? key : MONTH_NAMES[key] || key;
      style.header(c);
      ["Total", ...extras.map((d) => d.label)].forEach((label, k) => {
        const s = ws.getCell(r2, col + k);
        s.value = label;
        style.subHeader(s);
      });
      style.groupEdge(ws.getCell(r2, col));
    });
  }
  mergedHeader(countCol, countLabel);
  ws.getRow(r1).height = 20;
  ws.getRow(r2).height = 22;

  // ── Employee rows ──
  const grand = { total: 0, ot: 0, cells: new Array(bodyCols).fill(0) };
  const isAvgCell = new Array(bodyCols).fill(false);
  let row = r2 + 1;
  employees.forEach((e, index) => {
    const striped = index % 2 === 1;
    const name = ws.getCell(row, 1);
    name.value = e.employeeName || null;
    style.body(name, { striped });

    [[2, e.totalHours], [3, e.otHours]].forEach(([col, v]) => {
      const c = ws.getCell(row, col);
      c.value = num(v);
      style.body(c, { striped, numeric: true });
    });
    ws.getCell(row, 2).font = { ...ws.getCell(row, 2).font, bold: true };
    grand.total += e.totalHours || 0;
    grand.ot += e.otHours || 0;

    const values = [];
    if (isYearly) {
      const p = e.periods[periodKeys[0]] || {};
      extras.forEach((d) => values.push([p[d.field], d.key === "average"]));
    } else {
      periodKeys.forEach((key) => {
        const p = e.periods[key] || {};
        values.push([p.totalHours, false]);
        extras.forEach((d) => values.push([p[d.field], d.key === "average"]));
      });
    }
    values.forEach(([v, avg], i) => {
      const c = ws.getCell(row, firstGroupCol + i);
      c.value = num(v);
      style.body(c, { striped, numeric: true });
      isAvgCell[i] = avg;
      if (!avg) grand.cells[i] += v || 0;
    });
    if (!isYearly) periodKeys.forEach((_, p) => style.groupEdge(ws.getCell(row, firstGroupCol + p * groupWidth)));

    const count = ws.getCell(row, countCol);
    count.value = e.numberOfPeriods || null;
    style.body(count, { striped });
    count.alignment = { vertical: "middle", horizontal: "center" };
    row += 1;
  });

  // ── Total row ── (averages and the month count don't add up, so they stay blank)
  for (let col = 1; col <= lastCol; col++) style.total(ws.getCell(row, col));
  ws.getCell(row, 1).value = "Total";
  [[2, grand.total], [3, grand.ot]].forEach(([col, v]) => {
    const c = ws.getCell(row, col);
    c.value = num(v);
    style.total(c, { numeric: true });
  });
  grand.cells.forEach((v, i) => {
    if (isAvgCell[i]) return;
    const c = ws.getCell(row, firstGroupCol + i);
    c.value = num(v);
    style.total(c, { numeric: true });
  });
  row += 2;

  // ── Notes ──
  const noteCols = Math.min(lastCol, LEAD + 12);
  [
    "Hours come from the company's payroll exports: a cutoff that hasn't been exported to payroll isn't counted yet.",
    `Each cutoff counts in full toward the ${isQuarterly ? "quarter of the month" : "month"} it ends in (e.g. Jun 24 – Jul 7 counts in July); days are never split. A cutoff that starts in December and ends in January counts toward the new year.`,
    "Total Hrs = regular + driver + training + paid leave. Leave is already inside Total; the Leave column only shows it separately. OT Hrs is separate from Total.",
    `${countLabel}: how many ${isQuarterly ? "quarters" : "months"} in the selection had any hours.${extras.some((d) => d.key === "average") ? " Avg / cutoff = Total ÷ the number of cutoffs in that period." : ""}`,
  ].forEach((t) => {
    style.note(ws, row, noteCols, t);
    row += 1;
  });
  style.footer(ws, row + 1, noteCols, book);

  return XL.finish(book);
}

module.exports = { generateYearlyTotalHoursReportXlsx };
