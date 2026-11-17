// src/utils/generateTaskReportFormPDF.js
//
// BB-129 phase 2: one submitted questionnaire (custom form answers) as a US
// Letter portrait PDF on the shared report layout, styled like the Daily Task
// Report PDF:
//   header (TASK REPORT / INTERNAL) → form name + punch day → meta strip →
//   Attendance tiles (clock-in, clock-out, answered) → numbered questions with
//   answers → "Submitted by" block.
// Built on request from a SUBMITTED questionnaire only (the service enforces
// that). Uses the form snapshot saved with the answers. Every time is in the
// company's time zone.

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");
const { drawSignature } = require("@utils/generateDailyTaskReportPDF");

const { THEME, mm } = L;

/** Answer value → display text; null when unanswered. */
function answerText(q, v) {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
  switch (q.type) {
    case "checkboxes":
      return Array.isArray(v) ? v.join(", ") : String(v);
    case "yes_no":
      return v === true ? "Yes" : v === false ? "No" : String(v);
    case "date": {
      const m = moment(v, "YYYY-MM-DD", true);
      return m.isValid() ? m.format("MMM D, YYYY") : String(v);
    }
    case "time": {
      const m = moment(v, "HH:mm", true);
      return m.isValid() ? m.format("h:mm A") : String(v);
    }
    default:
      return String(v);
  }
}

/**
 * @param {object} view  from taskReportFormResponseService.loadForPdf
 * @returns {Promise<Buffer>}
 */
function generateTaskReportFormPDF(view) {
  try {
    const { company, employee, response } = view;
    const tz = company.timeZone;
    const formName = response.form.name || "Questionnaire";
    const day = moment.tz(response.punchDate, "YYYY-MM-DD", tz);
    const submitted = response.submittedAt ? moment.tz(response.submittedAt, tz) : null;
    const generatedLabel = moment.tz(tz).format("MMM D, YYYY, h:mm A z");

    const w = L.createReport({
      orientation: "portrait",
      tag: "internal",
      company: company.name,
      reportName: formName,
      eyebrow: "Task report",
      generatedLabel,
      continuation: { title: formName, detail: `${employee.name}  ·  ${day.format("MMM D, YYYY")}` },
      info: { Title: `BizBuddy ${formName} — ${employee.name} — ${response.punchDate}`, Subject: "Clock-out documentation" },
    });

    // ── Title and meta ──
    L.title(w, formName, day.format("dddd, MMMM D, YYYY"));
    if (response.form.description) L.paragraph(w, L.safe(response.form.description), { size: 8, color: THEME.muted });
    L.metaStrip(w, [
      { label: "Company", value: company.name },
      { label: "Employee", value: employee.name, sub: employee.jobTitle || undefined },
      { label: "Department", value: employee.department || "—" },
      { label: "Shift", value: response.shiftName || "—" },
      {
        label: "Submitted",
        value: submitted ? submitted.format("MMM D, YYYY, h:mm A") : "—",
        sub: `${L.zoneCity(tz)} (${moment.tz(response.submittedAt || new Date(), tz).format("z")})`,
      },
    ]);

    // ── Attendance (this punch) ──
    L.sectionTitle(w, "Attendance");
    const stamp = (d) => (d ? moment.tz(d, tz) : null);
    const inAt = stamp(response.punch.timeIn);
    const outAt = stamp(response.punch.timeOut);
    L.kpiTiles(w, [
      {
        label: "Clock-in",
        value: inAt ? inAt.format("h:mm:ss A") : "—",
        sub: inAt ? `${inAt.format("ddd, MMM D, YYYY")} · ${inAt.format("z")}` : "—",
      },
      {
        label: "Clock-out",
        value: outAt ? outAt.format("h:mm:ss A") : "—",
        sub: outAt ? `${outAt.format("ddd, MMM D, YYYY")} · ${outAt.format("z")}` : "—",
      },
      { label: "Answered", value: `${response.answeredCount} of ${response.questionCount}`, sub: "Questions" },
    ]);

    // ── Answers ──
    L.sectionTitle(w, "Answers");
    drawAnswers(w, response.form.questions, response.answers || {});

    // ── Submitted by ──
    drawSignature(w, employee.name, submitted ? `Submitted electronically in BizBuddy · ${submitted.format("MMM D, YYYY, h:mm:ss A z")}` : "");

    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Numbered rows: bold question (* when required), answer underneath; header repeats on new pages. */
function drawAnswers(w, questions, answers) {
  const { doc, left, width } = w;
  const numW = mm(8);
  const pad = mm(2);
  const textW = width - numW - pad * 2;
  const headH = mm(7);

  const header = () => {
    doc.rect(left, w.y, width, headH).fill(THEME.fill);
    L.font(doc, "Helvetica-Bold", 6.5, THEME.muted);
    doc.text("#", left, w.y + (headH - 6.5) / 2 + 0.5, { width: numW, align: "center", characterSpacing: 0.4, lineBreak: false });
    doc.text("QUESTION AND ANSWER", left + numW + pad, w.y + (headH - 6.5) / 2 + 0.5, { characterSpacing: 0.4, lineBreak: false });
    doc.moveTo(left, w.y + headH).lineTo(left + width, w.y + headH).lineWidth(mm(0.3)).strokeColor(THEME.rule2).stroke();
    w.y += headH;
  };

  if (!questions.length) {
    L.paragraph(w, "This form has no questions.", { color: THEME.muted });
    return;
  }

  L.ensure(w, headH + mm(14));
  header();
  questions.forEach((q, i) => {
    const label = L.safe(`${q.label}${q.required ? " *" : ""}`);
    const text = answerText(q, answers[q.id]);
    const answer = text === null ? "Not answered" : L.safe(text);

    doc.font("Helvetica-Bold").fontSize(9);
    const labelH = doc.heightOfString(label, { width: textW });
    doc.font("Helvetica").fontSize(9);
    const answerH = doc.heightOfString(answer, { width: textW });
    const rowH = Math.max(mm(11), labelH + answerH + mm(6));

    if (w.y + rowH > w.bottom) {
      L.newPage(w);
      header();
    }
    const top = w.y + mm(2.5);
    L.font(doc, "Helvetica", 8.5, THEME.muted).text(String(i + 1), left, top + 0.5, { width: numW, align: "center", lineBreak: false });
    L.font(doc, "Helvetica-Bold", 9, THEME.ink).text(label, left + numW + pad, top, { width: textW });
    L.font(doc, "Helvetica", 9, text === null ? THEME.muted : THEME.ink).text(answer, left + numW + pad, top + labelH + mm(1.5), { width: textW });
    w.y += rowH;
    doc.moveTo(left, w.y).lineTo(left + width, w.y).lineWidth(mm(0.2)).strokeColor(THEME.rule).stroke();
  });
  w.y += mm(2);
  L.paragraph(w, "* Required question", { size: 7, color: THEME.muted });
}

module.exports = { generateTaskReportFormPDF };
