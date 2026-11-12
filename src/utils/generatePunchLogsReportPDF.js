// src/utils/generatePunchLogsReportPDF.js
//
// BB-119 phase 1b (docs/changelog-v2.11.7.md): the Punch Logs report
// as a US Letter landscape PDF on the shared report layout (Client report).
// One generator for both pages — scope=mine (employee "My Punch Logs") and
// scope=team (company "Employee Punch Logs"). Data comes from
// punchLogReportService.buildPunchLogReport (read-only).
//
// Layout: title + data-basis badge (Final / Preliminary / Partly final), meta
// strip, summary tiles, cutoff periods (when reported by cutoff), by employee
// (team only), punches (striped), fixed hours (BB-089, when any), notes.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, PILL, mm } = L;

const BASIS = {
  final: { label: "Final", ...PILL.ok },
  preliminary: { label: "Preliminary", ...PILL.warn },
  partial: { label: "Partly final", ...PILL.info },
};
const OT_PILL = {
  Approved: PILL.ok,
  Pending: PILL.warn,
  Included: PILL.info,
  Excluded: PILL.neutral,
  Rejected: PILL.bad,
};
const CUTOFF_PILL = {
  Approved: { label: "Approved", ...PILL.ok },
  "Pending review": { label: "Pending", ...PILL.warn },
  Excluded: { label: "Excluded", ...PILL.neutral },
};

const dash = { text: "—", color: THEME.faint };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const h2 = (v) => (v == null ? null : Number(v).toFixed(2));
// Hours cell: null → "—"; zero → faint "0.00" (or "—" when zeroDash).
const hrs = (v, { zeroDash = false } = {}) => {
  if (v == null) return dash;
  if (Number(v) === 0) return zeroDash ? dash : { text: "0.00", color: THEME.faint };
  return { text: h2(v) };
};

/**
 * @param {object} report  from buildPunchLogReport
 * @returns {Promise<Buffer>}
 */
function generatePunchLogsReportPDF(report) {
  try {
    const { company, requester, scope, filters, periods, basis, summary: s, rows, byEmployee, fixedHours, hasDriverAide, cutoffOt, cutoffBasis } = report;
    const tz = company.timeZone;
    const team = scope.team;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");
    const subject = team ? plural(s.employees, "employee") : rows[0]?.employeeName || requester.name;

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Punch Logs Report",
      eyebrow: "Time & attendance",
      generatedLabel,
      continuation: { title: "Punch Logs Report", detail: `${filters.rangeLabel}  ·  ${team ? company.name : subject}` },
      info: { Title: `BizBuddy Punch Logs Report — ${company.name}`, Subject: "Punch logs" },
    });

    // ── Title and meta ──
    L.title(w, "Punch Logs Report", `${filters.rangeLabel}  ·  ${subject}`, { pill: BASIS[basis] });

    const reviewedCount = periods.filter((p) => p.reviewed).length;
    const dataItem =
      basis === "final"
        ? { value: "Reviewed, paid hours", sub: periods.length > 1 ? "All cutoffs locked" : "Cutoff locked" }
        : basis === "partial"
          ? { value: "Partly reviewed", sub: `${reviewedCount} of ${periods.length} cutoffs locked` }
          : { value: "Live punches", sub: "May change in cutoff review" };

    const filterBits = [filters.punchLabel, filters.statusLabel];
    if (team && filters.departmentId) filterBits.push(rows[0]?.department || "one department");
    if (team && filters.employeeIds.length) filterBits.push(plural(filters.employeeIds.length, "employee") + " chosen");

    L.metaStrip(w, [
      { label: "Company", value: company.name },
      team ? { label: "Covers", value: scope.label } : { label: "Employee", value: subject },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(tz)} time`, sub: tz },
      { label: "Data", ...dataItem },
      { label: "Filters", value: periods.length ? plural(periods.length, "cutoff period") : "Date range", sub: filterBits.join(" · ") },
    ]);

    // ── Summary ──
    L.sectionTitle(w, "Summary");
    L.kpiTiles(w, [
      team
        ? { label: "Employees", value: String(s.employees), sub: `${plural(s.days, "work day")}` }
        : { label: "Work days", value: String(s.days), sub: plural(s.records, "record") },
      {
        label: "Worked hours",
        value: h2(s.worked),
        sub: s.pendingReview ? `${plural(s.pendingReview, "row")} pending review` : basis === "preliminary" ? "As recorded" : "Payable hours",
        subColor: s.pendingReview ? PILL.warn.fg : undefined,
      },
      { label: "Scheduled hours", value: h2(s.scheduled), sub: "From assigned shifts" },
      { label: "Overtime hours", value: s.otHours == null ? "—" : h2(s.otHours), sub: s.otHours == null ? "Pick a cutoff period" : otTileSub(company) },
      { label: "Late hours", value: h2(s.late), sub: "Behind shift start" },
    ]);

    // ── Cutoff periods (only when reported by cutoff) ──
    if (periods.length) {
      L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * Math.min(periods.length, 3));
      L.sectionTitle(w, "Cutoff periods", { note: "Locked or processed cutoffs show reviewed hours; open ones show live punches" });
      L.table(w, [
        { label: "Period", width: 150, cell: (p) => ({ text: `${fmtDate(p.start)} – ${fmtDate(p.end)}` }) },
        { label: "Department", width: null, cell: (p) => ({ text: p.department || "All departments", color: p.department ? THEME.ink : THEME.muted }) },
        { label: "Cutoff status", width: 110, cell: (p) => ({ text: cutoffStatusLabel(p.status) }) },
        { label: "Data", width: 110, cell: (p) => ({ pill: p.reviewed ? BASIS.final : BASIS.preliminary }) },
      ], periods);
    }

    // ── By employee (team) ──
    const hasFixed = fixedHours.length > 0;
    if (team && byEmployee.length) {
      L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * Math.min(byEmployee.length + 1, 4));
      L.sectionTitle(w, "By employee", { note: plural(byEmployee.length, "employee") });
      const totalRow = {
        __total: true,
        employeeName: "Total",
        days: s.days,
        worked: s.worked,
        scheduled: s.scheduled,
        otHours: s.otHours,
        otStatus: null,
        late: s.late,
        fixedHours: hasFixed ? byEmployee.reduce((t, e) => t + (Number(e.fixedHours) || 0), 0) : null,
      };
      L.table(
        w,
        [
          { label: "Employee", width: null, cell: (e) => ({ text: e.listName || e.employeeName }) },
          { label: "Days", width: 56, align: "right", cell: (e) => ({ text: String(e.days) }) },
          { label: "Worked", width: 70, align: "right", cell: (e) => hrs(e.worked) },
          { label: "Scheduled", width: 70, align: "right", cell: (e) => hrs(e.scheduled, { zeroDash: true }) },
          { label: cutoffBasis ? "Overtime (cutoff)" : "Overtime", width: cutoffBasis ? 84 : 70, align: "right", cell: (e) => (cutoffBasis && !periods.length ? dash : hrs(e.otHours, { zeroDash: true })) },
          ...(cutoffBasis ? [{ label: "OT status", width: 70, cell: (e) => (e.otStatus && OT_PILL[e.otStatus] ? { pill: { label: e.otStatus, ...OT_PILL[e.otStatus] } } : dash) }] : []),
          { label: "Late", width: 70, align: "right", cell: (e) => hrs(e.late, { zeroDash: true }) },
          ...(hasFixed ? [{ label: "Fixed hours", width: 76, align: "right", cell: (e) => hrs(e.fixedHours, { zeroDash: true }) }] : []),
        ],
        [...byEmployee, totalRow],
        { isTotal: (e) => e.__total, striped: byEmployee.length > 6 }
      );
    }

    // ── Punches ──
    L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * 5);
    L.sectionTitle(w, "Punches", {
      note: rows.length ? `${plural(rows.length, "record")}${team ? ", by employee then date" : ", by date"}` : undefined,
    });
    if (!rows.length) {
      L.paragraph(w, "No punches match these filters.", { color: THEME.muted });
    } else {
      const clock = (d, r) => {
        if (!d) return null;
        const m = moment(d).tz(tz);
        const nextDay = m.format("YYYY-MM-DD") > r.date ? " (+1)" : "";
        return `${m.format("h:mm A")}${nextDay}${r.clockAdjusted ? "*" : ""}`;
      };
      const cols = [
        ...(team ? [{ label: "Employee", width: null, cell: (r) => ({ text: r.listName || r.employeeName }) }] : []),
        { label: "Date", width: 52, cell: (r) => ({ text: fmtDate(r.date) }) },
        { label: "In", width: 48, cell: (r) => ({ text: clock(r.clockIn, r) || "—", color: r.clockIn ? THEME.ink : THEME.faint }) },
        {
          label: "Out",
          width: 56,
          cell: (r) => {
            const t = clock(r.clockOut, r);
            if (t) return { text: t };
            return r.active ? { text: "Clocked in", color: PILL.info.fg } : dash;
          },
        },
        { label: "Punch type", width: team ? 58 : null, cell: (r) => ({ text: r.punchLabel, color: r.punchType === "REGULAR" ? THEME.muted : THEME.ink }) },
        { label: "Worked", width: 42, align: "right", cell: (r) => hrs(r.worked) },
        ...(hasDriverAide
          ? [
              { label: "D/A AM", width: 34, align: "right", cell: (r) => hrs(r.am, { zeroDash: r.am == null }) },
              { label: "Regular", width: 44, align: "right", cell: (r) => hrs(r.regular, { zeroDash: r.regular == null }) },
              { label: "D/A PM", width: 34, align: "right", cell: (r) => hrs(r.pm, { zeroDash: r.pm == null }) },
            ]
          : []),
        { label: "Scheduled", width: 52, align: "right", cell: (r) => hrs(r.scheduled, { zeroDash: true }) },
        // Cutoff-basis OT isn't per day — it's listed under "Overtime by cutoff" instead.
        ...(cutoffBasis
          ? []
          : [
              { label: "OT", width: 30, align: "right", cell: (r) => hrs(r.otHours, { zeroDash: true }) },
              {
                label: "OT status",
                width: 60,
                cell: (r) => {
                  if (!r.otStatus || r.otStatus === "—") return dash;
                  const style = OT_PILL[r.otStatus];
                  return style ? { pill: { label: r.otStatus, ...style } } : { text: r.otStatus, color: THEME.muted };
                },
              },
            ]),
        { label: "Late", width: 32, align: "right", cell: (r) => hrs(r.late, { zeroDash: true }) },
        { label: "Undertime", width: 52, align: "right", cell: (r) => hrs(r.undertime, { zeroDash: true }) },
        {
          label: "Cutoff status",
          width: 62,
          cell: (r) => (CUTOFF_PILL[r.cutoffStatus] ? { pill: CUTOFF_PILL[r.cutoffStatus] } : { text: "No cutoff", color: THEME.faint }),
        },
      ];

      // The employee's own report gets a total row; the team report has the By employee table.
      const list = team
        ? rows
        : [
            ...rows,
            {
              __total: true, date: null, punchLabel: "", worked: s.worked, scheduled: s.scheduled, otHours: s.otHours,
              late: s.late, undertime: rows.reduce((t, r) => t + (Number(r.undertime) || 0), 0),
              am: hasDriverAide ? rows.reduce((t, r) => t + (Number(r.am) || 0), 0) : null,
              regular: hasDriverAide ? rows.reduce((t, r) => t + (Number(r.regular) || 0), 0) : null,
              pm: hasDriverAide ? rows.reduce((t, r) => t + (Number(r.pm) || 0), 0) : null,
            },
          ];
      const totalAware = cols.map((c) => ({
        ...c,
        cell: (r) => {
          if (!r.__total) return c.cell(r);
          if (c.label === "Date") return { text: "Total" };
          if (["In", "Out", "Punch type", "OT status", "Cutoff status"].includes(c.label)) return { text: "" };
          return c.cell(r);
        },
      }));
      L.table(w, totalAware, list, { striped: true, isTotal: (r) => r.__total });
    }

    // ── Overtime by cutoff (cutoff basis) ──
    if (cutoffBasis && periods.length) {
      L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * Math.max(1, Math.min(cutoffOt.length, 3)));
      L.sectionTitle(w, "Overtime by cutoff", { note: `Hours above ${h2(company.otThreshold).replace(/\.00$/, "")}h in a cutoff (OT Configuration)` });
      if (!cutoffOt.length) {
        L.paragraph(w, "No overtime in these cutoff periods.", { color: THEME.muted });
      } else {
        L.table(w, [
          ...(team ? [{ label: "Employee", width: null, cell: (x) => ({ text: x.listName || x.employeeName }) }] : []),
          { label: "Cutoff period", width: team ? 150 : null, cell: (x) => ({ text: x.periodStart ? `${fmtDate(x.periodStart)} – ${fmtDate(x.periodEnd)}` : "—" }) },
          { label: "Overtime hours", width: 90, align: "right", cell: (x) => hrs(x.otHours) },
          { label: "OT status", width: 80, cell: (x) => (OT_PILL[x.status] ? { pill: { label: x.status, ...OT_PILL[x.status] } } : { text: x.status }) },
        ], cutoffOt);
      }
    }

    // ── Fixed hours (BB-089) ──
    if (hasFixed) {
      const periodById = new Map(periods.map((p) => [p.id, p]));
      const nameOf = new Map(rows.map((r) => [r.userId, r.listName || r.employeeName]));
      const list = fixedHours
        .map((x) => ({
          ...x,
          employeeName: nameOf.get(x.userId) || [x.user?.profile?.lastName, x.user?.profile?.firstName].filter(Boolean).join(", ") || x.user?.email || "Unknown",
          period: periodById.get(x.cutoffPeriodId),
        }))
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
      L.ensure(w, mm(5) + mm(4.2) + mm(2.5) + mm(7) + mm(6.5) * Math.min(list.length, 3));
      L.sectionTitle(w, "Fixed hours", { note: "Flat hours per cutoff; they cover scheduled duty, so those punches show as Excluded" });
      L.table(w, [
        ...(team ? [{ label: "Employee", width: null, cell: (x) => ({ text: x.employeeName }) }] : []),
        { label: "Cutoff period", width: team ? 150 : null, cell: (x) => ({ text: x.period ? `${fmtDate(x.period.start)} – ${fmtDate(x.period.end)}` : "—" }) },
        { label: "Fixed hours", width: 80, align: "right", cell: (x) => hrs(x.hours) },
        { label: "Paid leave", width: 80, align: "right", cell: (x) => hrs(x.leaveHours, { zeroDash: true }) },
        { label: "Regular", width: 80, align: "right", cell: (x) => hrs(x.regularHours) },
      ], list);
    }

    // ── Notes ──
    const notes = [
      `Dates and times are in ${L.zoneCity(tz)} time (${tz}), the company's time zone. "(+1)" means the clock-out was on the next day. * means the time was changed in cutoff review (it differs from the punch); the reviewed time is shown.`,
    ];
    if (basis !== "preliminary")
      notes.push("For locked or processed cutoffs, hours are the reviewed, payable hours: one row per employee per day, and excluded or rejected punches count as 0.");
    if (basis !== "final")
      notes.push("Live punches show hours as recorded. They can still change when the cutoff is reviewed.");
    notes.push(otNote(company, cutoffBasis && !periods.length));
    if (hasDriverAide) notes.push("Driver/Aide days are split into AM, Regular and PM segments; Worked is their sum.");
    notes.push("The Details CSV adds employee details and coffee and lunch minutes.");
    L.endNote(w, notes);

    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

function cutoffStatusLabel(status) {
  return { open: "Open", locked: "Locked", processed: "Processed" }[status] || (status ? status.charAt(0).toUpperCase() + status.slice(1) : "—");
}

const hoursLabel = (v) => `${Number(v).toFixed(2).replace(/\.00$/, "")}h`;

function otTileSub(company) {
  if (company.isBnC) return "Daily OT blocks";
  if (company.otBasis === "cutoff") return `Over ${hoursLabel(company.otThreshold)} per cutoff, not excluded`;
  return "Approved OT requests";
}

function otNote(company, noCutoff) {
  if (company.isBnC)
    return "Overtime comes from the cutoff's daily OT blocks: Approved, Pending or Excluded.";
  if (company.otBasis === "cutoff")
    return noCutoff
      ? `Overtime is counted per cutoff (hours above ${hoursLabel(company.otThreshold)} in a cutoff, per the company's OT Configuration), so a date-range report doesn't show it. Choose cutoff periods to see overtime.`
      : `Overtime is counted per cutoff: hours above ${hoursLabel(company.otThreshold)} in a cutoff, per the company's OT Configuration. It isn't split by day, so it's listed under "Overtime by cutoff". Pending means it hasn't been approved yet; Excluded overtime isn't paid and isn't in the totals.`;
  const per = company.otBasis === "weekly" ? "week" : "day";
  return `Overtime shows approved OT requests (OT Configuration: over ${hoursLabel(company.otThreshold)} a ${per}). "Pending" means a request is waiting; "Not requested" means extra time was recorded but no OT request was made.`;
}

module.exports = { generatePunchLogsReportPDF };
