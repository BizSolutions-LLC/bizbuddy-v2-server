// src/utils/generateDepartmentsReportPDF.js
//
// BB-119: the Departments report as a US Letter landscape PDF on the shared
// report layout (Client report). Data comes from departmentReportService.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");
const { coffeeText, autoLunchText, autoCoffeeText, fixedText, cutoffText } = require("@services/Reports/departmentReportService");

const { THEME, PILL, mm } = L;

const dash = { text: "—", color: THEME.faint };
const num = (n) => (n ? { text: String(n) } : { text: "0", color: THEME.faint });
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "Off" / "None" / "Company schedule" print muted so the set values stand out.
const setting = (text, isSet) => ({ text, color: isSet ? THEME.ink : THEME.muted });
const notApplied = (text) => ({ text, color: THEME.faint });

/**
 * @param {object} report  from buildDepartmentReport
 * @returns {Promise<Buffer>}
 */
function generateDepartmentsReportPDF(report) {
  try {
    const { company, requester, scope, summary: s, rows, autoState } = report;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Departments Report",
      eyebrow: "People & organization",
      generatedLabel,
      continuation: { title: "Departments Report", detail: company.name },
      info: { Title: `BizBuddy Departments Report — ${company.name}`, Subject: "Company departments and their time & pay settings" },
    });

    // ── Title and meta ──
    L.title(w, "Departments Report", `${plural(s.departments, "department")}  ·  ${plural(s.inDepartments, "employee")} assigned`);
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(company.timeZone)} time`, sub: company.timeZone },
      { label: "Scope", value: scope.label, sub: scope.detail },
    ]);

    // ── Summary ──
    L.sectionTitle(w, "Summary");
    L.kpiTiles(w, [
      { label: "Departments", value: String(s.departments), sub: s.ownCutoff ? `${s.ownCutoff} with their own cutoff schedule` : "All on the company schedule" },
      {
        label: "With a supervisor",
        value: String(s.withSupervisor),
        sub: s.inactiveSupervisor ? `${s.inactiveSupervisor} supervisor${s.inactiveSupervisor === 1 ? " is" : "s are"} inactive` : "All supervisors active",
        subColor: s.inactiveSupervisor ? PILL.warn.fg : undefined,
      },
      { label: "Without a supervisor", value: String(s.withoutSupervisor), sub: s.withoutSupervisor ? "Needs a supervisor assigned" : "Every department covered" },
      { label: "Employees assigned", value: String(s.inDepartments), sub: `${s.activeInDepartments} active` },
      report.unassigned
        ? { label: "Not in a department", value: String(s.unassigned), sub: s.unassigned ? "Assign them to a department" : "Everyone assigned" }
        : { label: "Fixed-hours departments", value: String(s.fixedHours), sub: "Flat hours per cutoff" },
    ]);

    // ── Departments ──
    L.sectionTitle(w, "Departments", { note: "sorted by name" });
    if (!rows.length) {
      L.paragraph(w, "No departments yet.", { color: THEME.muted });
    } else {
      const extra = report.unassigned?.total ? [{ name: "Not in a department", none: true, ...report.unassigned }] : [];
      const all = [...rows, ...extra];
      const totals = all.reduce(
        (t, r) => ({ total: t.total + r.total, active: t.active + r.active, inactive: t.inactive + r.inactive, fullTime: t.fullTime + r.fullTime, partTime: t.partTime + r.partTime }),
        { total: 0, active: 0, inactive: 0, fullTime: 0, partTime: 0 }
      );
      L.table(
        w,
        [
          { label: "Department", width: null, cell: (r) => (r.isTotal ? { text: "Total" } : { text: r.name, color: r.none ? THEME.muted : THEME.ink }) },
          {
            label: "Supervisor",
            width: 150,
            cell: (r) =>
              r.isTotal || r.none
                ? { text: "" }
                : r.supervisorName
                  ? { text: `${r.supervisorName}${r.supervisorInactive ? " (inactive)" : ""}`, color: r.supervisorInactive ? PILL.warn.fg : THEME.ink }
                  : { text: "No supervisor", color: PILL.warn.fg },
          },
          { label: "Employees", width: 64, align: "right", cell: (r) => ({ text: String(r.total), bold: true }) },
          { label: "Active", width: 56, align: "right", cell: (r) => num(r.active) },
          { label: "Inactive", width: 56, align: "right", cell: (r) => num(r.inactive) },
          { label: "Full-time", width: 60, align: "right", cell: (r) => num(r.fullTime) },
          { label: "Part-time", width: 60, align: "right", cell: (r) => num(r.partTime) },
          { label: "Created", width: 64, align: "right", cell: (r) => (r.isTotal || r.none ? { text: "" } : r.createdOn ? { text: fmtDate(r.createdOn) } : dash) },
        ],
        [...all, { isTotal: true, ...totals }],
        { isTotal: (r) => r.isTotal, striped: true }
      );
    }

    // ── Time & pay settings ──
    if (rows.length) {
      L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * 4 + 20);
      L.sectionTitle(w, "Time & pay settings", { note: "how each department's breaks, hours and cutoffs are set up" });
      if (autoState.note) L.paragraph(w, autoState.note, { size: 8, color: PILL.warn.fg });
      L.table(
        w,
        [
          { label: "Department", width: null, cell: (r) => ({ text: r.name }) },
          { label: "Lunch paid", width: 52, cell: (r) => setting(r.lunchPaid ? "Yes" : "No", r.lunchPaid) },
          { label: "Coffee breaks", width: 96, cell: (r) => setting(coffeeText(r), r.coffeeCount > 0) },
          {
            label: "Auto lunch",
            width: 128,
            cell: (r) => (r.autoLunch && !autoState.lunchOn ? notApplied(`${autoLunchText(r)} (not used)`) : setting(autoLunchText(r), !!r.autoLunch)),
          },
          {
            label: "Auto coffee",
            width: 112,
            cell: (r) => (r.autoCoffee && !autoState.coffeeOn ? notApplied(`${autoCoffeeText(r)} (not used)`) : setting(autoCoffeeText(r), !!r.autoCoffee)),
          },
          { label: "Fixed hours", width: 72, cell: (r) => setting(fixedText(r), r.fixedHours != null) },
          { label: "Cutoff schedule", width: 150, cell: (r) => setting(cutoffText(r, fmtDate), !!r.cutoff) },
        ],
        rows,
        { striped: true }
      );
    }

    L.endNote(w, [
      "Employees counts real people assigned to the department; a supervisor counts only if they are a member. Inactive accounts are signed out and receive no notifications.",
      "Lunch paid: when No, lunch breaks are deducted from worked hours. Auto lunch and auto coffee are added when an employee doesn't take the break themselves; \"(not used)\" means a company setting keeps them off.",
      "Fixed hours: members get a flat number of hours per cutoff whatever they punch. Cutoff schedule: \"Company schedule\" means the department follows the company's pay periods.",
    ]);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateDepartmentsReportPDF };
