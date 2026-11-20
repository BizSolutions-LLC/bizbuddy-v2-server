// src/utils/generateNewBusinessWorkbook.js
//
// BB-139: blank "New Business Requirement Details" onboarding workbook.
// Collects what we need to create a company, its admin, supervisors and employees,
// plus optional setup sheets (departments, shifts, payroll/cutoff, leave, holidays,
// locations) that B. Buddy can also set up later. Static template: no DB reads.
// Served by GET /api/system-admin/onboarding-workbook.
const ExcelJS = require("exceljs");

const FONT = "Arial";
const C = {
  orange: "FFF68525", ink: "FF1F2328", muted: "FF6B7280", rule: "FFE5E7EB",
  red: "FFC0392B", white: "FFFFFFFF", exampleBg: "FFF3F4F6", inputBg: "FFFFFBF5",
  reqBg: "FFFDECEA", optBg: "FFEFF6FF", optFg: "FF1D4ED8",
};

// ---- shared dropdown lists (hidden "Lists" sheet) ----
const LISTS = {
  YesNo: ["Yes", "No"],
  TimeZone: [
    "America/Los_Angeles (Pacific)", "America/Denver (Mountain)", "America/Phoenix (Arizona)",
    "America/Chicago (Central)", "America/New_York (Eastern)", "America/Anchorage (Alaska)",
    "Pacific/Honolulu (Hawaii)", "Asia/Manila (Philippines)",
  ],
  PayrollCountry: ["US", "PH", "Other"],
  Currency: ["USD", "PHP", "Other"],
  Role: ["Employee", "Supervisor", "Admin"],
  EmploymentStatus: ["Full-time", "Part-time"],
  EmploymentType: ["W-2 Employee", "1099 Contractor"],
  ExemptStatus: ["Non-exempt", "Exempt"],
  WorkLocation: ["Onsite", "Remote", "Hybrid"],
  PayType: ["Hourly", "Salary"],
  CutoffFrequency: ["Bi-weekly", "Bi-monthly (1st-15th / 16th-end)", "Monthly"],
  OtBasis: ["Daily", "Weekly", "Per cutoff"],
  AppliesTo: ["All employees", "Department", "Individual employee"],
  Accrual: ["Monthly", "Yearly", "None"],
  Unit: ["Hours", "Days"],
  HolidayType: ["Regular", "Special", "Double"],
};
const listRef = {};


function font(cell, opts = {}) { cell.font = { name: FONT, size: 10, color: { argb: C.ink }, ...opts }; }
function fill(cell, argb) { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } }; }
function border(cell) {
  const s = { style: "thin", color: { argb: C.rule } };
  cell.border = { top: s, bottom: s, left: s, right: s };
}

function titleBlock(ws, title, subtitle, required, lastCol) {
  ws.mergeCells(1, 1, 1, lastCol);
  const t = ws.getCell(1, 1);
  t.value = title; font(t, { size: 14, bold: true });
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, lastCol);
  const s = ws.getCell(2, 1);
  s.value = subtitle; font(s, { size: 9, color: { argb: C.muted } });
  s.alignment = { wrapText: true, vertical: "top" };
  ws.getRow(2).height = 30;
  const b = ws.getCell(3, 1);
  b.value = required ? "REQUIRED SHEET" : "OPTIONAL SHEET - B. Buddy can set this up after the company is created";
  font(b, { size: 8, bold: true, color: { argb: required ? C.red : C.optFg } });
  for (let i = 1; i <= lastCol; i++) ws.getCell(3, i).border = { bottom: { style: "medium", color: { argb: C.orange } } };
}

function applyValidation(cell, col) {
  if (col.list) {
    cell.dataValidation = {
      type: "list", allowBlank: true, formulae: [col.list.startsWith("=") ? col.list.slice(1) : listRef[col.list]],
      showErrorMessage: !col.freeText, errorStyle: "warning",
      error: "Please pick a value from the list.",
    };
  } else if (col.type === "date") {
    cell.numFmt = "mm/dd/yyyy";
    cell.dataValidation = { type: "date", operator: "greaterThan", allowBlank: true, formulae: [new Date(1900, 0, 1)],
      showErrorMessage: true, errorStyle: "warning", error: "Please enter a date (MM/DD/YYYY)." };
  } else if (col.type === "number") {
    cell.dataValidation = { type: "decimal", operator: "greaterThanOrEqual", allowBlank: true, formulae: [0],
      showErrorMessage: true, errorStyle: "warning", error: "Please enter a number." };
  } else if (col.type === "email") {
    cell.dataValidation = { type: "custom", allowBlank: true, formulae: [`ISNUMBER(FIND("@",${cell.address}))`],
      showErrorMessage: true, errorStyle: "warning", error: "This doesn't look like an email address." };
  }
}

// Table: header row, hint row, example row, then `rows` blank input rows.
// Returns the first/last input row so other sheets can point dropdowns at it.
function table(ws, startRow, { heading, columns, example, rows }) {
  let r = startRow;
  if (heading) {
    const h = ws.getCell(r, 1); h.value = heading; font(h, { size: 11, bold: true }); r += 1;
  }
  const headerRow = r, hintRow = r + 1, exampleRow = r + 2, first = r + 3, last = r + 2 + rows;
  columns.forEach((col, i) => {
    const c = i + 1;
    if (!heading || !ws.getColumn(c).width || ws.getColumn(c).width < (col.width || 18)) ws.getColumn(c).width = col.width || 18;
    const hc = ws.getCell(headerRow, c);
    hc.value = col.required ? `${col.header} *` : col.header;
    font(hc, { size: 9, bold: true, color: { argb: C.white } });
    fill(hc, col.required ? C.orange : "FF9CA3AF");
    hc.alignment = { wrapText: true, vertical: "middle" };
    border(hc);
    const nc = ws.getCell(hintRow, c);
    nc.value = col.hint || (col.required ? "Required" : "Optional");
    font(nc, { size: 8, italic: true, color: { argb: col.required ? C.red : C.muted } });
    nc.alignment = { wrapText: true, vertical: "top" };
    fill(nc, col.required ? C.reqBg : C.exampleBg);
    border(nc);
    const ec = ws.getCell(exampleRow, c);
    ec.value = example ? example[i] : null;
    font(ec, { size: 9, italic: true, color: { argb: C.muted } });
    fill(ec, C.exampleBg); border(ec);
    if (col.type === "date") ec.numFmt = "mm/dd/yyyy";
    for (let rr = first; rr <= last; rr++) {
      const cell = ws.getCell(rr, c);
      font(cell, { size: 10 }); border(cell);
      applyValidation(cell, col);
    }
  });
  ws.getRow(headerRow).height = 30;
  ws.getRow(hintRow).height = 34;
  const lab = ws.getCell(exampleRow, columns.length + 1);
  lab.value = "<- example row, leave or overwrite"; font(lab, { size: 8, italic: true, color: { argb: C.muted } });
  return { headerRow, first, last, end: last };
}

// Form: Field | Value | Notes
function form(ws, startRow, { heading, fields }) {
  let r = startRow;
  if (heading) { const h = ws.getCell(r, 1); h.value = heading; font(h, { size: 11, bold: true }); r += 1; }
  ["Field", "Your answer", "Notes"].forEach((t, i) => {
    const c = ws.getCell(r, i + 1); c.value = t;
    font(c, { size: 9, bold: true, color: { argb: C.white } }); fill(c, C.orange); border(c);
  });
  r += 1;
  for (const f of fields) {
    const a = ws.getCell(r, 1);
    a.value = f.required ? `${f.label} *` : f.label;
    font(a, { size: 10, bold: true, color: { argb: f.required ? C.red : C.ink } });
    fill(a, f.required ? C.reqBg : C.exampleBg); border(a);
    a.alignment = { vertical: "middle", wrapText: true };
    const v = ws.getCell(r, 2);
    font(v, { size: 10 }); fill(v, C.inputBg); border(v);
    if (f.default !== undefined) { v.value = f.default; }
    applyValidation(v, f);
    const n = ws.getCell(r, 3);
    n.value = f.note || null; font(n, { size: 8, color: { argb: C.muted } }); border(n);
    n.alignment = { wrapText: true, vertical: "middle" };
    ws.getRow(r).height = 22;
    r += 1;
  }
  return r;
}

async function generateNewBusinessWorkbook() {
  const book = new ExcelJS.Workbook();
  book.creator = "BizBuddy";
  book.created = new Date();

  // ---------- Instructions ----------
  const ins = book.addWorksheet("Instructions", { properties: { tabColor: { argb: C.orange } } });
  ins.getColumn(1).width = 4; ins.getColumn(2).width = 110;
  ins.mergeCells("A1:B1");
  ins.getCell("A1").value = "BizBuddy - New Business Requirement Details";
  font(ins.getCell("A1"), { size: 16, bold: true });
  ins.getRow(1).height = 28;
  const lines = [
    ["h", "What this workbook is for"],
    ["p", "We use the details in this workbook to create your company in BizBuddy, your admin account, and your supervisor and employee accounts."],
    ["h", "How to fill it in"],
    ["p", "1. Fill in the four REQUIRED sheets: Company, Admin Account, Supervisors, Employees. Add your department names on the Departments sheet so the department dropdowns work."],
    ["p", "2. Columns marked * (orange header / red label) are required. Grey columns are optional."],
    ["p", "3. The grey row under each header is an example. You can overwrite it or leave it; we ignore it."],
    ["p", "4. Use one row per person. Every person needs their own unique email address, which becomes their login."],
    ["p", "5. Where a cell has a dropdown, please pick from the list."],
    ["p", "6. The OPTIONAL sheets (departments settings, shifts, payroll and cutoff, leave, holidays, locations) are welcome if you already know them. If not, leave them blank: B. Buddy, your BizBuddy setup assistant, can set them up with you after the company is created."],
    ["h", "What we create for you"],
    ["p", "- Usernames and account IDs are generated by us."],
    ["p", "- Do NOT write passwords in this workbook. Each person gets a welcome email with their login details."],
    ["p", "- Sensitive data (SSN/ITIN, bank details) is not collected here. Employees enter it in the app themselves when needed."],
    ["h", "Sheets"],
    ["p", "Required (orange tabs): Company, Admin Account, Supervisors, Employees.  Optional:   Departments (names needed), Shifts & Schedules, Payroll & Cutoff, Leave, Holidays, Locations"],
    ["h", "When you're done"],
    ["p", "Save the file and send it back to your BizBuddy contact. We'll confirm once your company and accounts are ready."],
  ];
  let ir = 3;
  for (const [k, t] of lines) {
    const c = ins.getCell(ir, 2); c.value = t;
    if (k === "h") { font(c, { size: 11, bold: true, color: { argb: C.orange } }); ins.getRow(ir).height = 22; }
    else { font(c, { size: 10 }); c.alignment = { wrapText: true }; ins.getRow(ir).height = t.length > 110 ? 30 : 16; }
    ir += 1;
  }

  // ---------- Hidden Lists ----------
  const lists = book.addWorksheet("Lists", { state: "veryHidden" });
  Object.entries(LISTS).forEach(([name, vals], i) => {
    const col = i + 1;
    lists.getCell(1, col).value = name;
    vals.forEach((v, j) => { lists.getCell(j + 2, col).value = v; });
    const letter = lists.getColumn(col).letter;
    listRef[name] = `Lists!$${letter}$2:$${letter}$${vals.length + 1}`;
  });

  // Department names come from the Departments sheet (rows filled below).
  const DEPT_FIRST = 8, DEPT_ROWS = 50;
  const deptList = `=Departments!$A$${DEPT_FIRST}:$A$${DEPT_FIRST + DEPT_ROWS - 1}`;

  // ---------- Company ----------
  const co = book.addWorksheet("Company", { properties: { tabColor: { argb: C.orange } } });
  co.getColumn(1).width = 34; co.getColumn(2).width = 42; co.getColumn(3).width = 60;
  titleBlock(co, "Company", "Your business details. These appear on reports and are used to set up your company account.", true, 3);
  form(co, 5, { fields: [
    { label: "Company legal name", required: true, note: "Must be unique in BizBuddy." },
    { label: "DBA / trade name", note: "If you operate under a different name." },
    { label: "EIN / Tax ID", note: "US EIN (XX-XXXXXXX) or PH TIN." },
    { label: "Business email", required: true, type: "email", note: "Main company contact email (not a person's login)." },
    { label: "Business phone", required: true },
    { label: "Website" },
    { label: "Address line 1", required: true },
    { label: "Address line 2" },
    { label: "City", required: true },
    { label: "State / Province", required: true },
    { label: "ZIP / Postal code" },
    { label: "Country", required: true, default: "United States" },
    { label: "Time zone", required: true, list: "TimeZone", note: "The time zone your employees work in. All punches and reports use it." },
    { label: "Currency", list: "Currency", default: "USD" },
    { label: "Payroll country", list: "PayrollCountry", default: "US", note: "Which payroll rules apply." },
    { label: "Approx. number of employees", type: "number", note: "Helps us pick the right subscription plan." },
    { label: "Subscription plan", note: "Leave blank. Filled in by BizBuddy." },
  ]});

  // ---------- Admin Account ----------
  const ad = book.addWorksheet("Admin Account", { properties: { tabColor: { argb: C.orange } } });
  [22, 22, 32, 18, 22, 40].forEach((w, i) => { ad.getColumn(i + 1).width = w; });
  titleBlock(ad, "Admin Account", "The account owner: the main admin who manages the company in BizBuddy. Admins see and approve everything for the company.", true, 6);
  const adminCols = [
    { header: "First name", required: true },
    { header: "Last name", required: true },
    { header: "Email (login)", required: true, type: "email", hint: "Required. Unique, becomes the login." },
    { header: "Mobile phone" },
    { header: "Job title" },
    { header: "Notes" },
  ];
  const own = table(ad, 5, { heading: "Account owner (one person)", columns: adminCols, example: ["Jane", "Smith", "jane.smith@yourcompany.com", "(555) 123-4567", "Operations Manager", ""], rows: 1 });
  table(ad, own.end + 3, { heading: "Additional admins (optional)", columns: adminCols.map((c) => ({ ...c, required: false, hint: undefined })), example: ["Mark", "Lee", "mark.lee@yourcompany.com", "", "HR Manager", ""], rows: 5 });

  // ---------- Supervisors ----------
  const sv = book.addWorksheet("Supervisors", { properties: { tabColor: { argb: C.orange } } });
  const svCols = [
    { header: "First name", required: true },
    { header: "Last name", required: true },
    { header: "Email (login)", required: true, type: "email", width: 30, hint: "Required. Unique, becomes the login." },
    { header: "Mobile phone" },
    { header: "Department they lead", required: true, list: deptList, freeText: true, width: 24, hint: "Required. Pick from the Departments sheet." },
    { header: "Employee ID", hint: "Your own ID number, if any." },
    { header: "Hire date", type: "date", width: 14, hint: "MM/DD/YYYY" },
    { header: "Job title", width: 22 },
    { header: "Also clocks in/out?", list: "YesNo", width: 14, hint: "Yes if the supervisor's own hours are tracked." },
  ];
  titleBlock(sv, "Supervisors", "Supervisors approve time, leave and schedules for their department's employees.", true, svCols.length);
  table(sv, 5, { columns: svCols, example: ["Maria", "Garcia", "maria.garcia@yourcompany.com", "(555) 222-3333", "Front Office", "EMP-002", new Date(2024, 2, 1), "Office Supervisor", "Yes"], rows: 30 });
  sv.views = [{ state: "frozen", ySplit: 5 }];

  // ---------- Employees ----------
  const em = book.addWorksheet("Employees", { properties: { tabColor: { argb: C.orange } } });
  const emCols = [
    { header: "First name", required: true },
    { header: "Last name", required: true },
    { header: "Email (login)", required: true, type: "email", width: 30, hint: "Required. Unique, becomes the login." },
    { header: "Mobile phone" },
    { header: "Employee ID", hint: "Your own ID number, if any. Unique." },
    { header: "Department", required: true, list: deptList, freeText: true, width: 22, hint: "Required. Pick from the Departments sheet." },
    { header: "Supervisor email", type: "email", width: 30, hint: "Email from the Supervisors sheet." },
    { header: "Hire date", required: true, type: "date", width: 14, hint: "Required. MM/DD/YYYY" },
    { header: "Job title", width: 22 },
    { header: "Role", list: "Role", width: 13, hint: "Default: Employee" },
    { header: "Full / part time", list: "EmploymentStatus", width: 14 },
    { header: "Employment type", list: "EmploymentType", width: 17 },
    { header: "Exempt status", list: "ExemptStatus", width: 13, hint: "US overtime rule. Most hourly staff are Non-exempt." },
    { header: "Work location", list: "WorkLocation", width: 13 },
    { header: "Work state", width: 12, hint: "e.g. CA" },
    { header: "Driver?", list: "YesNo", width: 10, hint: "Drives company vehicles / routes." },
    { header: "Pay type", list: "PayType", width: 11 },
    { header: "Pay rate", type: "number", width: 12, hint: "Per hour (hourly) or per year (salary)." },
  ];
  titleBlock(em, "Employees", "One row per employee. Supervisors and admins already listed on their own sheets don't need to be repeated here.", true, emCols.length);
  table(em, 5, { columns: emCols, example: ["John", "Doe", "john.doe@yourcompany.com", "(555) 444-5555", "EMP-010", "Front Office", "maria.garcia@yourcompany.com", new Date(2025, 0, 15), "Caregiver", "Employee", "Full-time", "W-2 Employee", "Non-exempt", "Onsite", "CA", "No", "Hourly", 18.5], rows: 200 });
  em.views = [{ state: "frozen", xSplit: 2, ySplit: 5 }];

  // ---------- Departments ----------
  const dp = book.addWorksheet("Departments");
  const dpCols = [
    { header: "Department name", required: true, width: 26, hint: "Needed for the dropdowns on Supervisors and Employees." },
    { header: "Supervisor email", type: "email", width: 30, hint: "Optional. From the Supervisors sheet." },
    { header: "Fixed hours per cutoff?", list: "YesNo", width: 16, hint: "Optional. Yes = paid a flat number of hours each cutoff." },
    { header: "Fixed hours amount", type: "number", width: 14, hint: "Optional. e.g. 80" },
    { header: "Paid break?", list: "YesNo", width: 12, hint: "Optional. Are breaks paid?" },
    { header: "Notes", width: 36 },
  ];
  titleBlock(dp, "Departments", "List your department (or team) names. The other columns are optional and can be set up later with B. Buddy.", false, dpCols.length);
  const dpT = table(dp, 5, { columns: dpCols, example: ["Front Office", "maria.garcia@yourcompany.com", "No", "", "No", ""], rows: DEPT_ROWS });
  if (dpT.first !== DEPT_FIRST) throw new Error(`Department rows start at ${dpT.first}, expected ${DEPT_FIRST}`);
  dp.views = [{ state: "frozen", ySplit: 5 }];

  // ---------- Shifts & Schedules ----------
  const sh = book.addWorksheet("Shifts & Schedules");
  const shCols = [
    { header: "Shift name", required: true, width: 22, hint: "e.g. Morning, Night, Patient A" },
    { header: "Start time", width: 11, hint: "e.g. 8:00 AM" },
    { header: "End time", width: 11, hint: "e.g. 5:00 PM" },
    { header: "Ends next day?", list: "YesNo", width: 13, hint: "Yes for overnight shifts." },
    { header: "Days of week", width: 18, hint: "e.g. Mon-Fri, or Mon, Wed, Fri" },
    { header: "Applies to", list: "AppliesTo", width: 18 },
    { header: "Department / employee", width: 30, hint: "Department name or employee email, if not all employees." },
    { header: "Schedule start date", type: "date", width: 14 },
    { header: "Schedule end date", type: "date", width: 14, hint: "Blank = ongoing" },
    { header: "Notes", width: 30 },
  ];
  titleBlock(sh, "Shifts & Schedules", "Your regular working shifts and who works them. Optional: B. Buddy can build schedules with you later.", false, shCols.length);
  table(sh, 5, { columns: shCols.map((c, i) => (i === 0 ? { ...c, required: false } : c)), example: ["Morning", "8:00 AM", "5:00 PM", "No", "Mon-Fri", "Department", "Front Office", new Date(2026, 11, 1), "", ""], rows: 30 });
  sh.views = [{ state: "frozen", ySplit: 5 }];

  // ---------- Payroll & Cutoff ----------
  const pc = book.addWorksheet("Payroll & Cutoff");
  pc.getColumn(1).width = 38; pc.getColumn(2).width = 30; pc.getColumn(3).width = 66;
  titleBlock(pc, "Payroll & Cutoff", "How your pay periods and overtime work. Optional: defaults are shown, change only what differs.", false, 3);
  form(pc, 5, { fields: [
    { label: "Pay period (cutoff) frequency", list: "CutoffFrequency" },
    { label: "First pay period start date", type: "date", note: "The start date of a recent or upcoming pay period (MM/DD/YYYY)." },
    { label: "Pay date: days after period ends", type: "number", default: 5, note: "Default 5." },
    { label: "Overtime counted", list: "OtBasis", default: "Daily", note: "Daily = after X hours a day; Weekly = after X hours a week; Per cutoff = after X hours per pay period." },
    { label: "Daily overtime after (hours)", type: "number", default: 8 },
    { label: "Weekly overtime after (hours)", type: "number", default: 40 },
    { label: "Per-cutoff overtime after (hours)", type: "number", default: 80 },
    { label: "Unpaid lunch (minutes)", type: "number", default: 60, note: "Deducted per workday. Enter 0 if no lunch is deducted." },
    { label: "Late grace period (minutes)", type: "number", default: 15, note: "How late an employee can clock in without being marked late." },
    { label: "Paid holidays / special pay rules", note: "Anything else we should know (free text)." },
  ]});

  // ---------- Leave, Holidays, Locations ----------
  const lv = book.addWorksheet("Leave, Holidays, Locations");
  titleBlock(lv, "Leave, Holidays, Locations", "Leave types, company holidays and work sites. Optional: B. Buddy can set these up with you later.", false, 7);
  const lvT = table(lv, 5, { heading: "Leave types", columns: [
    { header: "Leave type", width: 24, hint: "e.g. Sick Leave, Vacation" },
    { header: "Allowance per year", type: "number", width: 18 },
    { header: "Unit", list: "Unit", width: 14 },
    { header: "Earned", list: "Accrual", width: 14, hint: "Monthly accrual, yearly lump, or none" },
    { header: "Paid?", list: "YesNo", width: 12 },
    { header: "Unused carries over?", list: "YesNo", width: 16 },
    { header: "Notes", width: 30 },
  ], example: ["Sick Leave", 40, "Hours", "Monthly", "Yes", "No", ""], rows: 10 });
  const hoT = table(lv, lvT.end + 3, { heading: "Holidays (this year)", columns: [
    { header: "Holiday name" }, { header: "Date", type: "date" }, { header: "Pay type", list: "HolidayType" }, { header: "Notes" },
  ], example: ["Thanksgiving", new Date(2026, 10, 26), "Regular", ""], rows: 20 });
  table(lv, hoT.end + 3, { heading: "Work sites / locations (for clock-in location)", columns: [
    { header: "Site name" }, { header: "Full address" }, { header: "Latitude", type: "number" }, { header: "Longitude", type: "number" },
    { header: "Allowed radius (meters)", type: "number" }, { header: "Employees restricted to it?", list: "YesNo" }, { header: "Notes" },
  ], example: ["Main Office", "123 Main St, Sacramento, CA 95814", "", "", 100, "No", "Address is enough; we look up the coordinates."], rows: 10 });

  // Print setup
  book.worksheets.forEach((ws) => {
    if (ws.state !== "visible" && ws.name === "Lists") return;
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 1 };
  });


  return Buffer.from(await book.xlsx.writeBuffer());
}

module.exports = { generateNewBusinessWorkbook };
