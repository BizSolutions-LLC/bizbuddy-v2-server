// src/utils/pdf/reportLayout.js
//
// BB-119: the shared layout for every BizBuddy PDF report (PDFKit, US Letter).
// Built from the report template (docs: guide only), so all reports share one
// look: first-page header with a Client/Internal tag, a shorter header on later
// pages, a footer with "Page X of Y", meta strip, KPI tiles, section headings,
// tables that repeat their header row, status pills and an end marker.
//
// Usage:
//   const L = require("@utils/pdf/reportLayout");
//   const w = L.createReport({ orientation: "landscape", tag: "client", company, reportName, ... });
//   L.title(w, "Punch Logs Report", "Oct 14 – Oct 31, 2026");
//   L.metaStrip(w, [...]); L.sectionTitle(w, "Summary"); L.table(w, cols, rows);
//   const buffer = await L.finish(w);
//
// Times: every report prints times in ONE zone. Client reports use the
// company's time zone (BB-119); never the viewer's.
//
// Fonts: only the standard Helvetica set, which covers Latin-1, so every
// string goes through safe() ("→" becomes "to", "≥" becomes ">=").

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const mm = (v) => (v * 72) / 25.4;

const ASSETS = path.join(__dirname, "..", "..", "assets");
const LOGO_PATHS = [path.join(ASSETS, "bizbuddy-logo-report.png"), path.join(ASSETS, "bizbuddy-logo.png")];

const THEME = {
  orange: "#F68525",
  ink: "#1F2328",
  muted: "#6B7280",
  faint: "#B8BEC6",
  rule: "#E5E7EB",
  rule2: "#D1D5DB",
  fill: "#F4F4F5",
  tint: "#FEF1E6",
  stripe: "#FAFAFA", // alternate rows in wide detail tables (table option `striped`)
  white: "#FFFFFF",
};

// Colour only where it means something: status pills and the orange brand marks.
const PILL = {
  ok: { fg: "#166534", bg: "#DCFCE7" }, // Done, Approved
  warn: { fg: "#92400E", bg: "#FEF3C7" }, // Pending
  info: { fg: "#1E40AF", bg: "#DBEAFE" }, // Active, Ongoing
  bad: { fg: "#991B1B", bg: "#FEE2E2" }, // Rejected, Missed
  neutral: { fg: "#374151", bg: "#EEF0F3" },
};

// Internal = system-admin reports only; everything a company downloads is a Client report.
const TAG = {
  client: { label: "Client report", fg: "#B4561A", bg: "#FEF1E6", footer: (company) => (company ? `Confidential — ${company}` : "Confidential") },
  internal: { label: "Internal", fg: "#374151", bg: "#EEF0F3", footer: () => "Internal — Confidential" },
};

// ── Text ────────────────────────────────────────────────────────────────────

const LATIN = { "→": "to", "≥": ">=", "≤": "<=", "−": "-", "✓": "" };
const safe = (value) =>
  String(value ?? "")
    .replace(/[→≥≤−✓]/g, (ch) => LATIN[ch])
    .replace(/[^\x00-\xFF–—‘’“”•…]/g, "");

const font = (doc, name, size, color) => doc.font(name).fontSize(size).fillColor(color);

function fit(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}...`) > width) t = t.slice(0, -1);
  return `${t}...`;
}

/**
 * Largest font size (from `size` down to `min`, in 0.25 pt steps) at which `text`
 * fits `width` on one line. Sets the font on the doc and returns { size, text };
 * text is cut with "..." only if it still doesn't fit at `min`.
 */
function shrinkToFit(doc, name, text, width, size, { min = 5, characterSpacing = 0 } = {}) {
  let s = size;
  doc.font(name).fontSize(s);
  while (s > min && doc.widthOfString(text, { characterSpacing }) > width) {
    s = Math.max(min, s - 0.25);
    doc.fontSize(s);
  }
  if (doc.widthOfString(text, { characterSpacing }) <= width) return { size: s, text };
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}...`, { characterSpacing }) > width) t = t.slice(0, -1);
  return { size: s, text: `${t}...` };
}

// "America/Los_Angeles" → "Los Angeles"
const zoneCity = (tz) => String(tz || "UTC").split("/").pop().replace(/_/g, " ");

// ── Document ────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {"portrait"|"landscape"} [o.orientation]
 * @param {"client"|"internal"} [o.tag]
 * @param {string} [o.company]        printed in the client footer
 * @param {string} o.reportName       e.g. "Performance Report" (footer)
 * @param {string} [o.eyebrow]        small uppercase line above the tag
 * @param {string} o.generatedLabel   e.g. "Nov 6, 2026, 12:27 AM PST" (footer)
 * @param {{ title: string, detail?: string }} o.continuation  header text on pages 2+
 * @param {object} [o.info]           PDF metadata (Title, Subject)
 */
function createReport({ orientation = "portrait", tag = "client", company = null, reportName, eyebrow = "", generatedLabel = "", continuation, info = {} }) {
  const doc = new PDFDocument({ size: "LETTER", layout: orientation, margin: 0, bufferPages: true, info: { Author: "BizBuddy", ...info } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  done.catch(() => {}); // the caller gets the rejection through finish()

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = mm(14);
  const w = {
    doc,
    done,
    pageW,
    pageH,
    left,
    width: pageW - left * 2,
    right: pageW - left,
    top: mm(25), // content start on pages 2+
    bottom: pageH - mm(20),
    y: mm(33),
    meta: { tag: TAG[tag] || TAG.client, company, reportName, eyebrow, generatedLabel, continuation: continuation || { title: reportName } },
  };
  firstPageHeader(w);
  return w;
}

function newPage(w) {
  w.doc.addPage();
  w.y = w.top;
}

function ensure(w, h) {
  if (w.y + h > w.bottom) newPage(w);
}

function drawLogo(doc, x, y, width, height) {
  for (const file of LOGO_PATHS) {
    if (!fs.existsSync(file)) continue;
    try {
      doc.image(file, x, y, { fit: [width, height] });
      return;
    } catch {
      // unreadable image — try the next one
    }
  }
  font(doc, "Helvetica-Bold", height * 0.6, THEME.ink).text("Biz", x, y + height * 0.18, { continued: true, lineBreak: false });
  doc.fillColor(THEME.orange).text("Buddy", { lineBreak: false });
}

// ── Pills and tags ──────────────────────────────────────────────────────────

/**
 * Rounded status pill. style = { fg, bg, label? }. Returns its width.
 * align: "left" (x is the left edge), "right" (x is the right edge) or "center".
 */
function pill(doc, style, x, y, { align = "left", label, upper = false } = {}) {
  const text = safe(label ?? style.label ?? "");
  const opts = { characterSpacing: upper ? 0.4 : 0 };
  font(doc, "Helvetica-Bold", 7, style.fg);
  const pw = doc.widthOfString(upper ? text.toUpperCase() : text, opts) + mm(4);
  const ph = mm(4.4);
  const px = align === "right" ? x - pw : align === "center" ? x - pw / 2 : x;
  doc.roundedRect(px, y, pw, ph, mm(1)).fill(style.bg);
  font(doc, "Helvetica-Bold", 7, style.fg).text(upper ? text.toUpperCase() : text, px, y + (ph - 7) / 2 + 0.7, {
    width: pw,
    align: "center",
    lineBreak: false,
    ...opts,
  });
  return pw;
}

// ── Page furniture ──────────────────────────────────────────────────────────

function firstPageHeader(w) {
  const { doc, left, right, width, meta } = w;
  drawLogo(doc, left, mm(11), mm(36), mm(13.1));
  if (meta.eyebrow) {
    font(doc, "Helvetica-Bold", 6.5, THEME.muted).text(safe(meta.eyebrow).toUpperCase(), left, mm(12), {
      width,
      align: "right",
      characterSpacing: 0.5,
      lineBreak: false,
    });
  }
  pill(doc, meta.tag, right, mm(16.5), { align: "right", upper: true });
  doc.rect(left, mm(28) - mm(0.6), width, mm(0.6)).fill(THEME.orange);
}

function continuationHeader(w) {
  const { doc, left, right, width, meta } = w;
  drawLogo(doc, left, mm(9), mm(22), mm(8));
  const bold = safe(meta.continuation.title);
  const rest = meta.continuation.detail ? `  ·  ${safe(meta.continuation.detail)}` : "";
  doc.font("Helvetica-Bold").fontSize(8);
  const boldW = doc.widthOfString(bold);
  doc.font("Helvetica").fontSize(8);
  const restW = doc.widthOfString(rest);
  const x = right - boldW - restW;
  font(doc, "Helvetica-Bold", 8, THEME.ink).text(bold, x, mm(12), { lineBreak: false });
  if (rest) font(doc, "Helvetica", 8, THEME.muted).text(rest, x + boldW, mm(12), { lineBreak: false });
  doc.moveTo(left, mm(20)).lineTo(left + width, mm(20)).lineWidth(mm(0.25)).strokeColor(THEME.rule2).stroke();
}

function footer(w, page, pages) {
  const { doc, left, width, pageH, meta } = w;
  const ruleY = pageH - mm(16);
  const y = ruleY + mm(2.4);
  doc.moveTo(left, ruleY).lineTo(left + width, ruleY).lineWidth(mm(0.25)).strokeColor(THEME.rule2).stroke();

  const leftW = width * 0.5;
  const rest = `  ·  ${safe(meta.reportName)}  ·  ${safe(meta.tag.footer(meta.company))}`;
  font(doc, "Helvetica-Bold", 7, THEME.ink).text("BizBuddy", left, y, { lineBreak: false });
  const brandW = doc.widthOfString("BizBuddy");
  font(doc, "Helvetica", 7, THEME.muted);
  doc.text(fit(doc, rest, leftW - brandW), left + brandW, y, { lineBreak: false });

  if (meta.generatedLabel) {
    font(doc, "Helvetica", 7, THEME.muted).text(safe(`Generated ${meta.generatedLabel}`), left + width * 0.5, y, {
      width: width * 0.32,
      align: "center",
      lineBreak: false,
    });
  }
  font(doc, "Helvetica", 7, THEME.muted).text(`Page ${page} of ${pages}`, left + width * 0.82, y, { width: width * 0.18, align: "right", lineBreak: false });
}

/** Draws the page furniture on every page and ends the document. Resolves to the PDF Buffer. */
function finish(w) {
  const { doc } = w;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i > range.start) continuationHeader(w);
    footer(w, i - range.start + 1, range.count);
  }
  doc.end();
  return w.done;
}

// ── Content blocks ──────────────────────────────────────────────────────────

/** Report title (20 pt), an optional orange subtitle (the period) and an optional pill on the right. */
function title(w, text, subtitle, { pill: badge } = {}) {
  const { doc, left, width } = w;
  font(doc, "Helvetica-Bold", 20, THEME.ink).text(safe(text), left, w.y, { width, lineBreak: false });
  if (badge) pill(doc, badge, w.right, w.y + 4, { align: "right", label: badge.label });
  w.y += 24;
  if (subtitle) {
    font(doc, "Helvetica", 11, THEME.orange).text(safe(subtitle), left, w.y, { width, lineBreak: false });
    w.y += 14;
  }
  w.y += mm(4.5);
}

/** Equal columns of { label, value, sub? } with a rule underneath. */
function metaStrip(w, items) {
  const { doc, left, width } = w;
  const colW = width / items.length;
  let tallest = 0;
  items.forEach((item, i) => {
    const x = left + colW * i;
    const textW = colW - mm(4);
    const label = shrinkToFit(doc, "Helvetica-Bold", safe(item.label).toUpperCase(), textW, 6.5, { characterSpacing: 0.5 });
    doc.fillColor(THEME.muted).text(label.text, x, w.y, { width: textW + 1, characterSpacing: 0.5, lineBreak: false });
    let h = 9;
    font(doc, "Helvetica", 8.5, THEME.ink);
    const value = safe(item.value ?? "—");
    doc.text(value, x, w.y + h, { width: textW });
    h += doc.heightOfString(value, { width: textW });
    if (item.sub) {
      font(doc, "Helvetica", 7.5, THEME.muted);
      const sub = safe(item.sub);
      doc.text(sub, x, w.y + h + 1, { width: textW });
      h += doc.heightOfString(sub, { width: textW }) + 1;
    }
    tallest = Math.max(tallest, h);
  });
  w.y += tallest + mm(3);
  doc.moveTo(left, w.y).lineTo(left + width, w.y).lineWidth(mm(0.25)).strokeColor(THEME.rule).stroke();
}

/** Section heading after an orange bar; optional muted note and a pill on the right. */
function sectionTitle(w, text, { note, pill: badge } = {}) {
  ensure(w, 64);
  const { doc, left, right } = w;
  w.y += mm(5);
  doc.rect(left, w.y, mm(1.2), mm(4.2)).fill(THEME.orange);
  const tx = left + mm(1.2) + mm(2.5);
  font(doc, "Helvetica-Bold", 11, THEME.ink).text(safe(text), tx, w.y + 0.8, { lineBreak: false });
  if (note) {
    const tw = doc.widthOfString(safe(text));
    font(doc, "Helvetica", 7.5, THEME.muted).text(safe(note), tx + tw + mm(3), w.y + 3, { lineBreak: false });
  }
  if (badge) pill(doc, badge, right, w.y - 0.5, { align: "right", label: badge.label });
  w.y += mm(4.2) + mm(2.5);
}

/** Smaller bold heading inside a section. */
function subTitle(w, text) {
  ensure(w, 40);
  font(w.doc, "Helvetica-Bold", 9, THEME.ink).text(safe(text), w.left, w.y, { lineBreak: false });
  w.y += 14;
}

function paragraph(w, str, { size = 9, color = THEME.ink, bold = false, gapAfter = 6 } = {}) {
  const { doc, left, width } = w;
  const text = safe(str);
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
  const h = doc.heightOfString(text, { width });
  ensure(w, h);
  doc.fillColor(color).text(text, left, w.y, { width });
  w.y += h + gapAfter;
}

function bullets(w, items, empty, { size = 9 } = {}) {
  const { doc, left, width } = w;
  if (!items?.length) return paragraph(w, empty, { color: THEME.muted, size });
  for (const item of items) {
    const text = safe(item);
    doc.font("Helvetica").fontSize(size);
    const h = doc.heightOfString(text, { width: width - 14 });
    ensure(w, h + 4);
    doc.circle(left + 4, w.y + size * 0.48, 1.6).fill(THEME.orange);
    font(doc, "Helvetica", size, THEME.ink).text(text, left + 14, w.y, { width: width - 14 });
    w.y += h + 4;
  }
  w.y += 4;
}

/** KPI tiles: [{ label, value, sub?, subColor? }] in one row. KPI values are always ink. */
function kpiTiles(w, tiles) {
  const { doc, left, width } = w;
  const gap = mm(4);
  const tw = (width - gap * (tiles.length - 1)) / tiles.length;
  const th = mm(19);
  const pad = mm(3.5);
  ensure(w, th + mm(4));
  tiles.forEach((t, i) => {
    const x = left + (tw + gap) * i;
    doc.roundedRect(x, w.y, tw, th, mm(1.2)).lineWidth(mm(0.25)).fillAndStroke(THEME.white, THEME.rule);
    font(doc, "Helvetica-Bold", 6.5, THEME.muted);
    doc.text(fit(doc, safe(t.label).toUpperCase(), tw - pad * 2), x + pad, w.y + mm(3), { width: tw - pad * 2, characterSpacing: 0.5, lineBreak: false });
    font(doc, "Helvetica-Bold", 16, THEME.ink).text(safe(t.value), x + pad, w.y + mm(3) + 10, { width: tw - pad * 2, lineBreak: false });
    if (t.sub) {
      font(doc, "Helvetica", 7, t.subColor || THEME.muted);
      doc.text(fit(doc, safe(t.sub), tw - pad * 2), x + pad, w.y + th - mm(3) - 7, { width: tw - pad * 2, lineBreak: false });
    }
  });
  w.y += th + mm(4);
}

/**
 * Table with a header row that repeats on every page.
 * cols: [{ label, width, align?, cell(row) → { text, color, bold, mono, size, shrinkMin, pill } }]
 *   - text that's too long shrinks to fit one line (down to shrinkMin, default 6 pt), then gets "..."
 *   - pill: a PILL/status style ({ fg, bg, label? }); the label defaults to cell.text
 *   - widths are in points; pass null on one column to take the remaining width
 * options.isTotal(row) → true draws the row as a total (bold, header fill, ink rule above).
 * options.striped → very light alternate rows; use on wide detail tables, not short summaries.
 */
function table(w, cols, rows, { rowH = mm(6.5), size = 8, shrinkMin = 6, isTotal, striped = false } = {}) {
  const { doc, left, width } = w;
  const fixed = cols.reduce((t, c) => t + (c.width || 0), 0);
  const flex = cols.filter((c) => !c.width).length;
  const widths = cols.map((c) => c.width || Math.max((width - fixed) / (flex || 1), 20));
  const pad = mm(2);
  const headH = mm(7);

  const header = () => {
    doc.rect(left, w.y, width, headH).fill(THEME.fill);
    let x = left;
    cols.forEach((c, i) => {
      // One line always: shrink the label (6.5 pt down to 5 pt) rather than wrap it.
      const label = shrinkToFit(doc, "Helvetica-Bold", safe(c.label).toUpperCase(), widths[i] - pad * 2, 6.5, { characterSpacing: 0.4 });
      doc.fillColor(THEME.muted).text(label.text, x + pad, w.y + (headH - label.size) / 2 + 0.5, {
        width: widths[i] - pad * 2 + 1,
        align: c.align || "left",
        characterSpacing: 0.4,
        lineBreak: false,
      });
      x += widths[i];
    });
    doc.moveTo(left, w.y + headH).lineTo(left + width, w.y + headH).lineWidth(mm(0.3)).strokeColor(THEME.rule2).stroke();
    w.y += headH;
  };

  ensure(w, headH + rowH * 3);
  header();
  rows.forEach((row, index) => {
    if (w.y + rowH > w.bottom) {
      newPage(w);
      header();
    }
    const total = isTotal ? isTotal(row) : false;
    // Very light alternate rows for wide detail tables (lighter than header/total fill).
    if (striped && !total && index % 2 === 1) doc.rect(left, w.y, width, rowH).fill(THEME.stripe);
    if (total) {
      doc.rect(left, w.y, width, rowH).fill(THEME.fill);
      doc.moveTo(left, w.y).lineTo(left + width, w.y).lineWidth(mm(0.3)).strokeColor(THEME.ink).stroke();
    }
    let x = left;
    cols.forEach((c, i) => {
      const cell = c.cell(row) || {};
      const right = c.align === "right";
      if (cell.pill) {
        const px = right ? x + widths[i] - pad : x + pad;
        pill(doc, cell.pill, px, w.y + (rowH - mm(4.4)) / 2, { align: right ? "right" : "left", label: cell.pill.label ?? cell.text });
      } else {
        const face = cell.bold || total ? "Helvetica-Bold" : cell.mono ? "Courier" : "Helvetica";
        // Long text shrinks (down to shrinkMin, default 6 pt) before it's cut with "...".
        const shown = shrinkToFit(doc, face, safe(cell.text ?? ""), widths[i] - pad * 2, cell.size || size, { min: Math.min(cell.shrinkMin ?? shrinkMin, cell.size || size) });
        doc.fillColor(cell.color || THEME.ink);
        doc.text(shown.text, x + pad, w.y + (rowH - shown.size) / 2 + 0.5, {
          width: widths[i] - pad * 2 + 1, // +1: a string that exactly fills the cell must not wrap
          align: c.align || "left",
          lineBreak: false,
        });
      }
      x += widths[i];
    });
    if (!total) doc.moveTo(left, w.y + rowH).lineTo(left + width, w.y + rowH).lineWidth(mm(0.2)).strokeColor(THEME.rule).stroke();
    w.y += rowH;
  });
  w.y += mm(3);
}

/** Muted closing notes and the "— End of report —" marker. */
function endNote(w, lines = []) {
  const { doc, left, width } = w;
  w.y += mm(4);
  for (const line of lines) paragraph(w, line, { size: 7.5, color: THEME.muted, gapAfter: 2 });
  ensure(w, 14);
  w.y += mm(3);
  font(doc, "Helvetica", 7.5, THEME.faint).text("— End of report —", left, w.y, { width, align: "center", lineBreak: false });
  w.y += 12;
}

module.exports = {
  mm,
  THEME,
  PILL,
  TAG,
  safe,
  font,
  fit,
  shrinkToFit,
  zoneCity,
  createReport,
  newPage,
  ensure,
  pill,
  finish,
  title,
  metaStrip,
  sectionTitle,
  subTitle,
  paragraph,
  bullets,
  kpiTiles,
  table,
  endNote,
};
