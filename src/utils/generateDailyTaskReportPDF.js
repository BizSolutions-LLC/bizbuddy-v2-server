// src/utils/generateDailyTaskReportPDF.js
//
// BB-129: the Daily Task Report (clock-out documentation) as a US Letter
// portrait PDF on the shared report layout, following the template
// docs/BizBuddy_DailyTaskReport_John_Doe_2026-11-16.pdf:
//   header (TASK REPORT / INTERNAL) → title + day → meta strip →
//   Attendance tiles (raw clock-in, raw clock-out, task count) →
//   numbered Tasks (title, optional note) → "Submitted by" block.
// Built on request from a SUBMITTED report only (the service enforces that).
// Every time is in the company's time zone.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, mm } = L;

/**
 * @param {object} view  from dailyTaskReportService.loadForPdf
 * @returns {Promise<Buffer>}
 */
function generateDailyTaskReportPDF(view) {
  try {
    const { company, employee, attendance, report } = view;
    const tz = company.timeZone;
    const zoneAbbr = (d) => moment.tz(d || new Date(), tz).format("z");
    const day = moment.tz(report.reportDate, "YYYY-MM-DD", tz);
    const submitted = report.submittedAt ? moment.tz(report.submittedAt, tz) : null;
    const generatedLabel = moment.tz(tz).format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "portrait",
      tag: "internal",
      company: company.name,
      reportName: "Daily Task Report",
      eyebrow: "Task report",
      generatedLabel,
      continuation: { title: "Daily Task Report", detail: `${employee.name}  ·  ${day.format("MMM D, YYYY")}` },
      info: { Title: `BizBuddy Daily Task Report — ${employee.name} — ${report.reportDate}`, Subject: "Clock-out documentation" },
    });

    // ── Title and meta ──
    L.title(w, "Daily Task Report", day.format("dddd, MMMM D, YYYY"));
    const shift = attendance.shift ? `Shift ${attendance.shift.start} – ${attendance.shift.end}` : null;
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Employee", value: employee.name, sub: employee.jobTitle || undefined },
      { label: "Department", value: employee.department || "—" },
      { label: "Report date", value: day.format("MMM D, YYYY"), sub: shift || undefined },
      {
        label: "Submitted",
        value: submitted ? submitted.format("MMM D, YYYY, h:mm A") : "—",
        sub: `${L.zoneCity(tz)} (${zoneAbbr(report.submittedAt)})`,
      },
    ]);

    // ── Attendance ──
    L.sectionTitle(w, "Attendance");
    const stamp = (d) => (d ? moment.tz(d, tz) : null);
    const inAt = stamp(attendance.clockIn);
    const outAt = stamp(attendance.clockOut);
    L.kpiTiles(w, [
      {
        label: "Raw clock-in",
        value: inAt ? inAt.format("h:mm:ss A") : "—",
        sub: inAt ? `${inAt.format("ddd, MMM D, YYYY")} · ${inAt.format("z")}` : "No punch found",
      },
      {
        label: "Raw clock-out",
        value: attendance.stillClockedIn && !outAt ? "—" : outAt ? outAt.format("h:mm:ss A") : "—",
        sub: attendance.stillClockedIn
          ? "Still clocked in"
          : outAt
            ? `${outAt.format("ddd, MMM D, YYYY")} · ${outAt.format("z")}`
            : "No clock-out",
      },
      { label: "Tasks", value: String(report.taskCount), sub: "Listed by employee" },
    ]);
    if (attendance.punchCount > 1) {
      L.paragraph(w, `${attendance.punchCount} punches this day: first clock-in and last clock-out shown.`, { size: 7.5, color: THEME.muted });
    }

    // ── Tasks ──
    L.sectionTitle(w, "Tasks");
    drawTaskList(w, report.tasks);

    // ── Submitted by ──
    drawSignature(w, employee.name, submitted ? `Submitted electronically in BizBuddy · ${submitted.format("MMM D, YYYY, h:mm:ss A z")}` : "");

    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Numbered rows: bold title, optional muted note underneath; header repeats on new pages. */
function drawTaskList(w, tasks) {
  const { doc, left, width } = w;
  const numW = mm(8);
  const pad = mm(2);
  const textW = width - numW - pad * 2;
  const headH = mm(7);

  const header = () => {
    doc.rect(left, w.y, width, headH).fill(THEME.fill);
    L.font(doc, "Helvetica-Bold", 6.5, THEME.muted);
    doc.text("#", left, w.y + (headH - 6.5) / 2 + 0.5, { width: numW, align: "center", characterSpacing: 0.4, lineBreak: false });
    doc.text("TASK", left + numW + pad, w.y + (headH - 6.5) / 2 + 0.5, { characterSpacing: 0.4, lineBreak: false });
    doc.moveTo(left, w.y + headH).lineTo(left + width, w.y + headH).lineWidth(mm(0.3)).strokeColor(THEME.rule2).stroke();
    w.y += headH;
  };

  if (!tasks.length) {
    L.paragraph(w, "No tasks listed.", { color: THEME.muted });
    return;
  }

  L.ensure(w, headH + mm(12));
  header();
  tasks.forEach((t, i) => {
    const title = L.safe(t.title);
    const note = t.note ? L.safe(t.note) : "";
    doc.font("Helvetica-Bold").fontSize(9);
    const titleH = doc.heightOfString(title, { width: textW });
    doc.font("Helvetica").fontSize(8);
    const noteH = note ? doc.heightOfString(note, { width: textW }) + 2 : 0;
    const rowH = Math.max(mm(9), titleH + noteH + mm(5));

    if (w.y + rowH > w.bottom) {
      L.newPage(w);
      header();
    }
    const top = w.y + mm(2.5);
    const numY = note ? w.y + rowH / 2 - 4 : top + 0.5;
    L.font(doc, "Helvetica", 8.5, THEME.muted).text(String(i + 1), left, numY, { width: numW, align: "center", lineBreak: false });
    L.font(doc, "Helvetica-Bold", 9, THEME.ink).text(title, left + numW + pad, top, { width: textW });
    if (note) L.font(doc, "Helvetica", 8, THEME.muted).text(note, left + numW + pad, top + titleH + 2, { width: textW });
    w.y += rowH;
    doc.moveTo(left, w.y).lineTo(left + width, w.y).lineWidth(mm(0.2)).strokeColor(THEME.rule).stroke();
  });
  w.y += mm(3);
}

function drawSignature(w, name, line) {
  const { doc, left, width } = w;
  L.ensure(w, mm(30));
  w.y += mm(8);
  L.font(doc, "Helvetica-Bold", 6.5, THEME.muted).text("SUBMITTED BY", left, w.y, { characterSpacing: 0.5, lineBreak: false });
  w.y += mm(5);
  L.font(doc, "Helvetica-Bold", 11, THEME.ink).text(L.safe(name), left, w.y, { lineBreak: false });
  w.y += mm(6);
  doc.moveTo(left, w.y).lineTo(left + width * 0.46, w.y).lineWidth(mm(0.4)).strokeColor(THEME.ink).stroke();
  w.y += mm(1.5);
  if (line) L.font(doc, "Helvetica", 7, THEME.muted).text(L.safe(line), left, w.y, { lineBreak: false });
  w.y += mm(5);
}

module.exports = { generateDailyTaskReportPDF };
