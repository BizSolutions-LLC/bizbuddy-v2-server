// src/utils/generateLeaveCalendarReportPDF.js
//
// BB-119: the Leave Calendar report as a US Letter landscape PDF on the shared
// report layout (Client report). Page 1 is the month grid (one chip per person
// per day, coloured by status, earliest submitter first); the pages after it
// list every leave touching the month, so nobody hidden behind "+N more" is
// lost. Data comes from leaveCalendarReportService.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, PILL, mm, font, safe } = L;

const STATUS_STYLE = {
  pending: { label: "Pending", ...PILL.warn },
  pending_secondary: { label: "Pending final", ...PILL.warn },
  approved: { label: "Approved", ...PILL.ok },
  rejected: { label: "Rejected", ...PILL.bad },
  cancelled: { label: "Cancelled", ...PILL.neutral },
};
const PAY_PILL = {
  paid: { label: "Paid", ...PILL.ok },
  unpaid: { label: "Unpaid", ...PILL.neutral },
  partial: { label: "Partial", ...PILL.info },
};
const LEGEND = ["pending", "approved", "rejected", "cancelled"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dash = { text: "—", color: THEME.faint };
const fmtDate = (ymd) => (ymd ? moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY") : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function legend(w) {
  const { doc, left } = w;
  let x = left;
  font(doc, "Helvetica-Bold", 6.5, THEME.muted).text("STATUS", x, w.y + 2.5, { characterSpacing: 0.5, lineBreak: false });
  x += doc.widthOfString("STATUS", { characterSpacing: 0.5 }) + mm(3);
  for (const key of LEGEND) {
    x += L.pill(doc, STATUS_STYLE[key], x, w.y) + mm(2.5);
  }
  font(doc, "Helvetica", 7, THEME.muted).text("Pending includes requests waiting for a final approval.  Weekends are shaded.", x + mm(2), w.y + 2.5, { lineBreak: false });
  w.y += mm(4.4) + mm(3);
}

function grid(w, report) {
  const { doc, left, width } = w;
  const { month, days } = report;
  const weeks = Math.ceil((month.firstWeekday + month.daysInMonth) / 7);
  const cellW = width / 7;
  const headH = mm(6);
  const top = w.y;
  const rowH = (w.bottom - top - headH) / weeks;

  // Weekday header
  doc.rect(left, top, width, headH).fill(THEME.fill);
  WEEKDAYS.forEach((d, i) => {
    font(doc, "Helvetica-Bold", 7, THEME.muted).text(d.toUpperCase(), left + cellW * i, top + (headH - 7) / 2 + 0.5, {
      width: cellW,
      align: "center",
      characterSpacing: 0.4,
      lineBreak: false,
    });
  });

  const chipH = mm(3.6);
  const chipGap = mm(0.7);
  const pad = mm(1.2);
  for (let r = 0; r < weeks; r++) {
    for (let c = 0; c < 7; c++) {
      const x = left + cellW * c;
      const y = top + headH + rowH * r;
      const day = r * 7 + c - month.firstWeekday + 1;
      const inMonth = day >= 1 && day <= month.daysInMonth;
      if (!inMonth) doc.rect(x, y, cellW, rowH).fill(THEME.fill);
      else if (c === 0 || c === 6) doc.rect(x, y, cellW, rowH).fill(THEME.stripe);
      doc.rect(x, y, cellW, rowH).lineWidth(mm(0.2)).strokeColor(THEME.rule).stroke();
      if (!inMonth) continue;

      const chips = days[day] || [];
      font(doc, "Helvetica-Bold", 8, THEME.ink).text(String(day), x + pad, y + pad, { lineBreak: false });
      if (chips.length) {
        font(doc, "Helvetica", 6.5, THEME.muted).text(`${chips.length} off`, x + pad, y + pad + 0.8, { width: cellW - pad * 2, align: "right", lineBreak: false });
      }
      if (!chips.length) continue;

      // One column for 1–2 people, two columns when busier; "+N more" if it still doesn't fit.
      const cols = chips.length < 3 ? 1 : 2;
      const colGap = mm(0.8);
      const chipW = (cellW - pad * 2 - colGap * (cols - 1)) / cols;
      const startY = y + pad + mm(4.2);
      const rows = Math.max(0, Math.floor((y + rowH - pad - startY + chipGap) / (chipH + chipGap)));
      const capacity = rows * cols;
      if (!capacity) continue;
      const shown = chips.length <= capacity ? chips.length : capacity - 1;
      const at = (i) => ({ cx: x + pad + (i % cols) * (chipW + colGap), cy: startY + Math.floor(i / cols) * (chipH + chipGap) });
      for (let i = 0; i < shown; i++) {
        const style = STATUS_STYLE[chips[i].status] || STATUS_STYLE.cancelled;
        const { cx, cy } = at(i);
        doc.roundedRect(cx, cy, chipW, chipH, mm(0.8)).fill(style.bg);
        const label = L.shrinkToFit(doc, "Helvetica", safe(chips[i].name), chipW - mm(1.6), 6.5, { min: 5 });
        doc.fillColor(style.fg).text(label.text, cx + mm(0.8), cy + (chipH - label.size) / 2 + 0.4, { width: chipW - mm(1.6) + 1, lineBreak: false });
      }
      if (chips.length > shown) {
        const { cx, cy } = at(shown);
        doc.roundedRect(cx, cy, chipW, chipH, mm(0.8)).fill(THEME.fill);
        font(doc, "Helvetica-Bold", 6.5, THEME.muted).text(`+${chips.length - shown} more`, cx, cy + (chipH - 6.5) / 2 + 0.4, { width: chipW, align: "center", lineBreak: false });
      }
    }
  }
  w.y = w.bottom;
}

/**
 * @param {object} report  from buildLeaveCalendarReport
 * @returns {Promise<Buffer>}
 */
function generateLeaveCalendarReportPDF(report) {
  try {
    const { company, requester, scope, filters, summary: s, month, list } = report;
    const generatedLabel = report.generatedAt.format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "landscape",
      tag: "client",
      company: company.name,
      reportName: "Leave Calendar",
      eyebrow: "Time & attendance",
      generatedLabel,
      continuation: { title: "Leave Calendar", detail: `${month.label}  ·  ${company.name}` },
      info: { Title: `BizBuddy Leave Calendar — ${month.label} — ${company.name}`, Subject: "Leave calendar" },
    });

    // ── Page 1: the calendar ──
    L.title(w, "Leave Calendar", `${month.label}  ·  ${plural(s.requests, "request")}, ${plural(s.employees, "employee")}`);
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Requested by", value: requester.name, sub: requester.email },
      { label: "Generated", value: generatedLabel },
      { label: "Times shown in", value: `${L.zoneCity(company.timeZone)} time`, sub: company.timeZone },
      { label: "Filters", value: month.label, sub: `${filters.statusNames} · ${scope.label.toLowerCase()}` },
    ]);
    w.y += mm(3);
    legend(w);
    grid(w, report);

    // ── Page 2+: every leave touching the month ──
    L.newPage(w);
    L.sectionTitle(w, `Leave in ${month.label}`, { note: `${plural(list.length, "request")}, sorted by start date` });
    if (!list.length) {
      L.paragraph(w, "No leave requests match this month and these statuses.", { color: THEME.muted });
    } else {
      L.table(
        w,
        [
          { label: "Employee", width: null, cell: (l) => ({ text: l.employeeName }) },
          { label: "Leave type", width: 96, cell: (l) => (l.leaveType ? { text: l.leaveType } : dash) },
          { label: "Dates", width: 112, cell: (l) => ({ text: l.startDate === l.endDate ? fmtDate(l.startDate) : `${fmtDate(l.startDate)} – ${fmtDate(l.endDate)}` }) },
          { label: "Days this month", width: 74, align: "right", cell: (l) => ({ text: String(l.daysThisMonth), color: l.decided ? THEME.ink : THEME.muted }) },
          {
            label: "Hours this month",
            width: 78,
            align: "right",
            cell: (l) => (l.hoursThisMonth == null ? dash : { text: `${Number(l.hoursThisMonth).toFixed(2)}h` }),
          },
          { label: "Pay", width: 62, cell: (l) => (l.pay ? { pill: PAY_PILL[l.pay] } : dash) },
          { label: "Status", width: 70, cell: (l) => ({ pill: STATUS_STYLE[l.status] || { label: l.statusLabel, ...PILL.neutral } }) },
          { label: "Submitted", width: 62, cell: (l) => (l.submittedOn ? { text: fmtDate(l.submittedOn) } : dash) },
        ],
        list,
        { striped: true }
      );
    }

    L.endNote(w, [
      "Approved leaves mark only the days actually counted (weekends and days without shifts can be left out). Pending, rejected and cancelled requests mark the requested days, skipping Saturday and Sunday when the request excludes weekends; their Days are shown in grey and Hours as \"—\".",
      "Each day lists people in the order they submitted, earliest first. The full detail of every request is in the Leave Requests report.",
    ]);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateLeaveCalendarReportPDF };
