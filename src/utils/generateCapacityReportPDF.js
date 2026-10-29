// src/utils/generateCapacityReportPDF.js
//
// BB-113: a Performance report as a US Letter PDF (PDFKit, like the payslips).
// Drawn only from saved CapacityReport snapshots — the report itself, the period
// before it and the Baseline — so a report never changes after the fact. The
// logo is read from src/assets/bizbuddy-logo.png; without it the header falls
// back to a text wordmark.
//
// The standard PDF fonts only cover Latin-1, so every server string goes
// through safe() ("→" becomes "to", "≥" becomes ">=").

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const moment = require("moment-timezone");

const LOGO_PATH = path.join(__dirname, "..", "assets", "bizbuddy-logo.png");

const PAGE_W = 612;
const PAGE_H = 792;
const M = 48;
const W = PAGE_W - M * 2;
const TOP = 84; // content start on pages 2+
const BOTTOM = PAGE_H - 64;

const C = {
  ink: "#111827",
  text: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  panel: "#f9fafb",
  brand: "#f97316",
  brandDark: "#c2410c",
  brandTint: "#fff7ed",
  series2: "#475569",
};

const BAND = {
  excellent: { label: "Excellent", fg: "#047857", bg: "#d1fae5" },
  good: { label: "Good", fg: "#15803d", bg: "#dcfce7" },
  watch: { label: "Watch", fg: "#b45309", bg: "#fef3c7" },
  terrible: { label: "Terrible", fg: "#b91c1c", bg: "#fee2e2" },
};
const VERDICT = {
  ok: { label: "OK", fg: "#047857", bg: "#d1fae5" },
  watch: { label: "Watch", fg: "#b45309", bg: "#fef3c7" },
  upgrade: { label: "Upgrade", fg: "#b91c1c", bg: "#fee2e2" },
};
const BETTER = "#047857";
const WORSE = "#b91c1c";

// ── Text and numbers ────────────────────────────────────────────────────────

const LATIN = { "→": "to", "≥": ">=", "≤": "<=", "−": "-", "✓": "" };
const safe = (value) =>
  String(value ?? "")
    .replace(/[→≥≤−✓]/g, (ch) => LATIN[ch])
    .replace(/[^\x00-\xFF–—‘’“”•…]/g, "");

const has = (v) => v != null && Number.isFinite(Number(v));
const fmtNum = (v, digits = 0) =>
  has(v) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";

function fmtMs(ms) {
  if (!has(ms)) return "—";
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  if (n < 3600000) return `${fmtNum(n / 60000, 1)} min`;
  return `${fmtNum(n / 3600000, 1)} h`;
}

const fmtMb = (mb) => (has(mb) ? (mb >= 1024 ? `${fmtNum(mb / 1024, 2)} GB` : `${fmtNum(mb)} MB`) : "—");

function fmtValue(v, unit) {
  if (!has(v)) return "—";
  if (unit === "%") return `${fmtNum(v, 1)}%`;
  if (unit === "ms") return fmtMs(v);
  if (unit === "mb") return fmtMb(v);
  return fmtNum(v);
}

// Month-over-month change: percentage points for % metrics, relative % otherwise.
function fmtChange(now, before, unit, better) {
  if (!has(now) || !has(before)) return { text: "—", color: C.faint };
  const diff = Number(now) - Number(before);
  const rel = Number(before) ? (diff / Math.abs(Number(before))) * 100 : null;
  const tiny = unit === "%" ? Math.abs(diff) < 0.5 : rel == null ? diff === 0 : Math.abs(rel) < 2;
  if (tiny) return { text: "no change", color: C.muted };
  const sign = diff > 0 ? "+" : "-";
  const text =
    unit === "%" ? `${sign}${fmtNum(Math.abs(diff), 1)} pts` : rel == null ? `${sign}${fmtNum(Math.abs(diff))}` : `${sign}${fmtNum(Math.abs(rel))}%`;
  const improved = better === "lower" ? diff < 0 : better === "higher" ? diff > 0 : null;
  return { text, color: improved == null ? C.muted : improved ? BETTER : WORSE };
}

const fmtBound = (v, unit) => (unit === "ms" ? fmtMs(v) : unit === "%" ? `${v}%` : fmtNum(v));

// Excellent / good / watch / terrible cells; a band with no room (pool timeouts have no "good") is "—".
function bandCells(spec) {
  if (!spec?.bounds) return ["—", "—", "—", "—"];
  const [a, b, c] = spec.bounds;
  const [lt, ge] = spec.higherIsBetter ? [">", "<="] : ["<", ">="];
  const f = (v) => fmtBound(v, spec.unit);
  return [`${lt} ${f(a)}`, b === a ? "—" : `${lt} ${f(b)}`, c === b ? "—" : `${lt} ${f(c)}`, `${ge} ${f(c)}`];
}

const aimFor = (spec) => {
  const cells = bandCells(spec);
  return cells[1] === "—" ? cells[0] : cells[1];
};

const isBadBand = (b) => b === "watch" || b === "terrible";
const flaggedCount = (endpoints = []) =>
  endpoints.filter((e) => e.calls >= 20 && (isBadBand(e.band) || e.changeBand === "terrible")).length;
const sum = (rows, key) => (rows?.length ? rows.reduce((t, r) => t + (Number(r[key]) || 0), 0) : null);

// ── Drawing primitives ──────────────────────────────────────────────────────

const font = (doc, name, size, color) => doc.font(name).fontSize(size).fillColor(color);

function ensure(w, h) {
  if (w.y + h > BOTTOM) {
    w.doc.addPage();
    w.y = TOP;
  }
}

function fit(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}...`) > width) t = t.slice(0, -1);
  return `${t}...`;
}

function pill(doc, style, x, y, align = "left", label) {
  const text = safe(label ?? style.label).toUpperCase();
  font(doc, "Helvetica-Bold", 6.5, style.fg);
  const pw = doc.widthOfString(text) + 12;
  const px = align === "right" ? x - pw : x;
  doc.roundedRect(px, y, pw, 12, 6).fill(style.bg);
  font(doc, "Helvetica-Bold", 6.5, style.fg).text(text, px, y + 3.2, { width: pw, align: "center", lineBreak: false });
  return pw;
}

function drawLogo(doc, x, y, h) {
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, x, y, { fit: [170, h] });
      return;
    } catch {
      // unreadable image — fall through to the wordmark
    }
  }
  font(doc, "Helvetica-Bold", h * 0.6, C.ink).text("Biz", x, y + h * 0.18, { continued: true, lineBreak: false });
  doc.fillColor(C.brand).text("Buddy", { lineBreak: false });
}

function sectionTitle(w, title, verdict, note) {
  ensure(w, 64);
  const { doc } = w;
  w.y += 6;
  doc.rect(M, w.y + 1, 3, 14).fill(C.brand);
  font(doc, "Helvetica-Bold", 13, C.ink).text(safe(title), M + 11, w.y, { lineBreak: false });
  if (verdict) pill(doc, VERDICT[verdict] || VERDICT.ok, M + W, w.y + 2, "right");
  w.y += 21;
  doc.moveTo(M, w.y).lineTo(M + W, w.y).lineWidth(0.5).strokeColor(C.line).stroke();
  w.y += 9;
  if (note) paragraph(w, note, { size: 8.5, color: BAND.watch.fg });
}

function subTitle(w, title) {
  ensure(w, 40);
  font(w.doc, "Helvetica-Bold", 9.5, C.ink).text(safe(title), M, w.y, { lineBreak: false });
  w.y += 15;
}

function paragraph(w, str, { size = 9.5, color = C.text, bold = false, gapAfter = 6 } = {}) {
  const { doc } = w;
  const text = safe(str);
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
  const h = doc.heightOfString(text, { width: W });
  ensure(w, h);
  doc.fillColor(color).text(text, M, w.y, { width: W });
  w.y += h + gapAfter;
}

function bullets(w, items, empty) {
  const { doc } = w;
  if (!items?.length) return paragraph(w, empty, { color: C.muted });
  for (const item of items) {
    const text = safe(item);
    doc.font("Helvetica").fontSize(9.5);
    const h = doc.heightOfString(text, { width: W - 14 });
    ensure(w, h + 4);
    doc.circle(M + 4, w.y + 4.8, 1.7).fill(C.brand);
    font(doc, "Helvetica", 9.5, C.text).text(text, M + 14, w.y, { width: W - 14 });
    w.y += h + 4;
  }
  w.y += 4;
}

// cols: [{ label, width, align, cell(row) → { text, color, bold, mono, size, pill } }]
function table(w, cols, rows, { rowH = 19, size = 8.5 } = {}) {
  const { doc } = w;
  const header = () => {
    doc.rect(M, w.y, W, rowH).fill(C.panel);
    let x = M;
    for (const c of cols) {
      font(doc, "Helvetica-Bold", 6.8, C.muted).text(safe(c.label).toUpperCase(), x + 6, w.y + 6.5, {
        width: c.width - 12,
        align: c.align || "left",
        lineBreak: false,
      });
      x += c.width;
    }
    w.y += rowH;
  };
  ensure(w, rowH * 3);
  header();
  for (const row of rows) {
    if (w.y + rowH > BOTTOM) {
      doc.addPage();
      w.y = TOP;
      header();
    }
    let x = M;
    for (const c of cols) {
      const cell = c.cell(row) || {};
      const right = c.align === "right";
      if (cell.pill) {
        pill(doc, cell.pill, right ? x + c.width - 6 : x + 6, w.y + (rowH - 12) / 2, right ? "right" : "left", cell.text);
      } else {
        const cellSize = cell.size || size;
        font(doc, cell.bold ? "Helvetica-Bold" : cell.mono ? "Courier" : "Helvetica", cellSize, cell.color || C.text);
        doc.text(fit(doc, safe(cell.text ?? ""), c.width - 12), x + 6, w.y + (rowH - cellSize) / 2 + 0.5, {
          width: c.width - 12,
          align: c.align || "left",
          lineBreak: false,
        });
      }
      x += c.width;
    }
    doc.moveTo(M, w.y + rowH).lineTo(M + W, w.y + rowH).lineWidth(0.5).strokeColor(C.line).stroke();
    w.y += rowH;
  }
  w.y += 10;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => n <= step) * p;
}

function axisLabel(v, unit) {
  if (unit === "%") return `${Math.round(v)}%`;
  if (unit === "ms") return v >= 1000 ? `${fmtNum(v / 1000, 1)} s` : `${Math.round(v)} ms`;
  return v >= 1000 ? `${fmtNum(v / 1000, 1)}k` : fmtNum(v);
}

// Daily line or bar chart with light gridlines and dashed band guides.
function chart(w, { title, days, series, unit, guides = [], type = "line", height = 140, fixedMax }) {
  const { doc } = w;
  ensure(w, height + 22);
  font(doc, "Helvetica-Bold", 9, C.ink).text(safe(title), M, w.y, { lineBreak: false });
  let lx = M + W;
  for (const s of [...series].reverse()) {
    font(doc, "Helvetica", 7.5, C.muted);
    lx -= doc.widthOfString(s.label);
    doc.text(s.label, lx, w.y + 1, { lineBreak: false });
    lx -= 13;
    doc.rect(lx, w.y + 3.5, 9, 3).fill(s.color);
    lx -= 12;
  }
  w.y += 16;

  const box = { x: M + 40, y: w.y + 4, w: W - 40, h: height - 26 };
  const values = series.flatMap((s) => days.map((d) => d[s.key])).filter(has).map(Number);
  if (!values.length) {
    doc.roundedRect(M, box.y, W, box.h, 4).fill(C.panel);
    font(doc, "Helvetica", 9, C.muted).text("No data for this period.", M, box.y + box.h / 2 - 5, { width: W, align: "center" });
    w.y += height;
    return;
  }

  const max = fixedMax ?? niceMax(Math.max(...values, ...guides.map((g) => g.value)) * 1.1);
  const yOf = (v) => box.y + box.h - (Math.min(v, max) / max) * box.h;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const gy = yOf(v);
    doc.moveTo(box.x, gy).lineTo(box.x + box.w, gy).lineWidth(0.5).strokeColor(C.line).stroke();
    font(doc, "Helvetica", 6.8, C.faint).text(axisLabel(v, unit), M, gy - 3.5, { width: 34, align: "right", lineBreak: false });
  }

  const slot = box.w / days.length;
  const xOf = (i) => box.x + slot * (i + 0.5);
  if (type === "bar") {
    const s = series[0];
    days.forEach((d, i) => {
      if (!has(d[s.key]) || !Number(d[s.key])) return;
      const top = yOf(Number(d[s.key]));
      doc.rect(xOf(i) - slot * 0.32, top, slot * 0.64, box.y + box.h - top).fill(s.color);
    });
  } else {
    for (const s of series) {
      let pen = false;
      let drew = false;
      days.forEach((d, i) => {
        if (!has(d[s.key])) {
          pen = false;
          return;
        }
        const [px, py] = [xOf(i), yOf(Number(d[s.key]))];
        if (pen) doc.lineTo(px, py);
        else doc.moveTo(px, py);
        pen = true;
        drew = true;
      });
      if (drew) doc.lineWidth(1.6).lineJoin("round").strokeColor(s.color).stroke();
      days.forEach((d, i) => {
        if (has(d[s.key])) doc.circle(xOf(i), yOf(Number(d[s.key])), 1.5).fill(s.color);
      });
    }
  }

  for (const g of guides) {
    if (g.value > max) continue;
    const gy = yOf(g.value);
    doc.moveTo(box.x, gy).lineTo(box.x + box.w, gy).dash(3, { space: 3 }).lineWidth(0.8).strokeColor(g.color).stroke().undash();
    font(doc, "Helvetica", 6.5, g.color).text(g.label, box.x + box.w - 90, gy - 8.5, { width: 88, align: "right", lineBreak: false });
  }

  doc.moveTo(box.x, box.y + box.h).lineTo(box.x + box.w, box.y + box.h).lineWidth(0.8).strokeColor(C.faint).stroke();
  const every = Math.ceil(days.length / 8);
  days.forEach((d, i) => {
    if (i % every) return;
    font(doc, "Helvetica", 6.8, C.faint).text(moment(d.day, "YYYY-MM-DD").format("MMM D"), xOf(i) - 20, box.y + box.h + 5, {
      width: 40,
      align: "center",
      lineBreak: false,
    });
  });
  w.y += height + 8;
}

// ── Page furniture ──────────────────────────────────────────────────────────

function runningHeader(doc, ctx) {
  drawLogo(doc, M, 30, 20);
  font(doc, "Helvetica", 8, C.muted).text(`Performance Report · ${ctx.reportLabel} · ${ctx.rangeLabel}`, M, 36, { width: W, align: "right", lineBreak: false });
  doc.moveTo(M, 60).lineTo(M + W, 60).lineWidth(0.5).strokeColor(C.line).stroke();
}

function footer(doc, ctx, page, pages) {
  const y = PAGE_H - 46;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(C.line).stroke();
  font(doc, "Helvetica", 7.5, C.faint).text(`BizBuddy · Performance Report · ${ctx.reportLabel} · Internal`, M, y + 8, {
    width: W / 2,
    lineBreak: false,
  });
  font(doc, "Helvetica", 7.5, C.faint).text(`Page ${page} of ${pages}`, M + W / 2, y + 8, { width: W / 2, align: "right", lineBreak: false });
}

function cover(w, ctx) {
  const { doc } = w;
  drawLogo(doc, M, 38, 34);
  font(doc, "Helvetica-Bold", 7.5, C.muted).text("INFRASTRUCTURE & PERFORMANCE", M, 44, {
    width: W,
    align: "right",
    characterSpacing: 1,
    lineBreak: false,
  });
  font(doc, "Helvetica", 7.5, C.faint).text("Internal · System administrators", M, 56, { width: W, align: "right", lineBreak: false });
  doc.rect(M, 84, W, 2).fill(C.brand);

  w.y = 104;
  font(doc, "Helvetica-Bold", 24, C.ink).text(ctx.isBaseline ? "Baseline Report" : "Performance Report", M, w.y, { lineBreak: false });
  w.y += 31;
  font(doc, "Helvetica", 15, C.brandDark).text(`${ctx.headline}${ctx.partial ? " · to date" : ""}`, M, w.y, { lineBreak: false });
  w.y += 28;

  const meta = [
    ["Period", ctx.periodLabel],
    ["Generated", ctx.generatedLabel],
    ["Data", ctx.dataLabel],
  ];
  const colW = W / 3;
  let tallest = 0;
  meta.forEach(([label, value], i) => {
    const x = M + colW * i;
    font(doc, "Helvetica-Bold", 6.8, C.muted).text(label.toUpperCase(), x, w.y, { width: colW - 12, characterSpacing: 0.6, lineBreak: false });
    font(doc, "Helvetica", 8.5, C.ink);
    const h = doc.heightOfString(safe(value), { width: colW - 14 });
    doc.text(safe(value), x, w.y + 11, { width: colW - 14 });
    tallest = Math.max(tallest, h);
  });
  w.y += tallest + 22;
}

// ── Report sections ─────────────────────────────────────────────────────────

const COMPARE = [
  { label: "API server CPU, p95", unit: "%", better: "lower", get: (d) => d.capacity?.server?.cpu?.p95Percent },
  { label: "API server memory, p95 of limit", unit: "%", better: "lower", get: (d) => d.capacity?.server?.memory?.p95PercentOfLimit },
  { label: "Event-loop delay, p95", unit: "ms", better: "lower", get: (d) => d.capacity?.server?.eventLoop?.p95Ms },
  { label: "Database query latency, p95", unit: "ms", better: "lower", get: (d) => d.capacity?.database?.latency?.p95Ms },
  { label: "Database connections, peak", unit: "%", better: "lower", get: (d) => d.capacity?.database?.connections?.peakPercent },
  { label: "Database cache hit", unit: "%", better: "higher", get: (d) => d.capacity?.database?.cacheHitPercent },
  { label: "Database size", unit: "mb", better: null, get: (d) => d.capacity?.database?.storage?.sizeMb },
  { label: "Requests served", unit: "count", better: null, get: (d) => sum(d.daily, "requests") },
  { label: "Total server time", unit: "ms", better: null, get: (d) => d.capacity?.hotspots?.totalServerTimeMs },
  { label: "Server errors (5xx)", unit: "count", better: "lower", get: (d) => sum(d.daily, "serverErrors") },
  { label: "Endpoints flagged", unit: "count", better: "lower", get: (d) => flaggedCount(d.capacity?.hotspots?.endpoints) },
];

function kpiTiles(w, ctx) {
  const { doc } = w;
  const cap = ctx.data.capacity || {};
  const ref = ctx.refs[ctx.refs.length - 1]; // the Baseline when there is one
  const plans = cap.plans || {};
  const monthly = (plans.web?.current?.monthly ?? null) != null || (plans.db?.current?.monthly ?? null) != null
    ? (plans.web?.current?.monthly || 0) + (plans.db?.current?.monthly || 0)
    : null;
  const tile = (metric, band, label) => {
    const now = metric.get(ctx.data);
    const change = ref ? fmtChange(now, metric.get(ref.data), metric.unit, metric.better) : null;
    return {
      label,
      value: fmtValue(now, metric.unit),
      sub: change && change.text !== "—" ? { text: `${change.text} vs ${ref.label}`, color: change.color } : band ? { text: BAND[band]?.label || "", color: BAND[band]?.fg || C.muted } : { text: "", color: C.muted },
    };
  };
  const tiles = [
    tile(COMPARE[0], cap.server?.cpu?.band, "API CPU, p95"),
    tile(COMPARE[3], cap.database?.latency?.band, "DB latency, p95"),
    tile(COMPARE[10], null, "Endpoints flagged"),
    {
      label: "Hosting / month",
      value: monthly == null ? "—" : `$${fmtNum(monthly)}`,
      sub: {
        text: monthly == null ? "Plans not configured" : `API $${plans.web?.current?.monthly ?? "?"} + database $${plans.db?.current?.monthly ?? "?"}`,
        color: C.muted,
      },
    },
  ];

  const gap = 12;
  const tw = (W - gap * 3) / 4;
  const th = 64;
  ensure(w, th + 12);
  tiles.forEach((t, i) => {
    const x = M + (tw + gap) * i;
    doc.roundedRect(x, w.y, tw, th, 5).lineWidth(0.6).fillAndStroke("#ffffff", C.line);
    font(doc, "Helvetica-Bold", 6.5, C.muted).text(fit(doc, safe(t.label).toUpperCase(), tw - 20), x + 10, w.y + 10, { width: tw - 20, lineBreak: false });
    font(doc, "Helvetica-Bold", 17, C.ink).text(safe(t.value), x + 10, w.y + 24, { width: tw - 20, lineBreak: false });
    font(doc, "Helvetica", 7.5, t.sub.color).text(fit(doc, safe(t.sub.text), tw - 20), x + 10, w.y + 47, { width: tw - 20, lineBreak: false });
  });
  w.y += th + 16;
}

function executiveSummary(w, ctx) {
  const { doc } = w;
  const cap = ctx.data.capacity || {};
  sectionTitle(w, "Executive summary");

  const rec = safe(cap.recommendation || "No recommendation.");
  font(doc, "Helvetica-Bold", 10, C.ink);
  const recH = doc.heightOfString(rec, { width: W - 112 });
  const panelH = Math.max(recH + 22, 42);
  ensure(w, panelH + 8);
  doc.rect(M, w.y, W, panelH).fill(C.brandTint);
  doc.rect(M, w.y, 3, panelH).fill(C.brand);
  pill(doc, VERDICT[cap.overall] || VERDICT.ok, M + 16, w.y + panelH / 2 - 6);
  font(doc, "Helvetica-Bold", 10, C.ink).text(rec, M + 96, w.y + (panelH - recH) / 2, { width: W - 112 });
  w.y += panelH + 14;

  kpiTiles(w, ctx);

  subTitle(w, ctx.refs.length ? `Compared with ${ctx.refs.map((r) => r.label).join(" and the ")}` : "Key figures");
  const valueW = 86;
  const refW = 76;
  const changeW = 66;
  table(
    w,
    [
      { label: "Metric", width: W - valueW - ctx.refs.length * (refW + changeW), cell: (m) => ({ text: m.label, color: C.ink }) },
      { label: ctx.reportLabel + (ctx.partial ? " (to date)" : ""), width: valueW, align: "right", cell: (m) => ({ text: fmtValue(m.get(ctx.data), m.unit), bold: true, color: C.ink }) },
      ...ctx.refs.flatMap((r) => [
        { label: r.label, width: refW, align: "right", cell: (m) => ({ text: fmtValue(m.get(r.data), m.unit), color: C.muted }) },
        { label: "Change", width: changeW, align: "right", cell: (m) => fmtChange(m.get(ctx.data), m.get(r.data), m.unit, m.better) },
      ]),
    ],
    COMPARE,
    { size: 8 }
  );
  const notes = [];
  if (ctx.isBaseline) notes.push("This is the Baseline: every later report is compared with it.");
  else if (ctx.missingPrevious) notes.push(`${ctx.missingPrevious} isn't saved, so only the Baseline comparison is shown.`);
  if (ctx.partial) notes.push("This period is still running: requests, server time and errors cover only part of it, so they read lower than a full period.");
  if (ctx.refs.length) notes.push("Green changes are improvements and red changes are regressions; grey rows depend on traffic and are neither.");
  for (const n of notes) paragraph(w, n, { size: 8, color: C.muted, gapAfter: 3 });
  w.y += 6;
}

const planCells = (p) =>
  p
    ? [p.code, `${fmtNum(p.cpu, 1)} CPU`, p.ramMb >= 1024 ? `${fmtNum(p.ramMb / 1024)} GB` : `${p.ramMb} MB`, `$${fmtNum(p.monthly)}`]
    : ["Not configured", "—", "—", "—"];

function plansSection(w, ctx) {
  const plans = ctx.data.capacity?.plans || {};
  const ref = ctx.refs[0];
  const prevPlans = ref?.data?.capacity?.plans;
  sectionTitle(w, "Hosting plans & cost");

  const web = planCells(plans.web?.current);
  const db = planCells(plans.db?.current);
  const total = (plans.web?.current?.monthly || 0) + (plans.db?.current?.monthly || 0);
  table(
    w,
    [
      { label: "Service", width: 150, cell: (r) => ({ text: r.service, color: C.ink, bold: r.total }) },
      { label: "Plan", width: 96, cell: (r) => ({ text: r.cells[0], mono: !r.total, color: C.ink }) },
      { label: "CPU", width: 64, align: "right", cell: (r) => ({ text: r.cells[1] }) },
      { label: "Memory", width: 68, align: "right", cell: (r) => ({ text: r.cells[2] }) },
      { label: "Disk", width: 68, align: "right", cell: (r) => ({ text: r.disk }) },
      { label: "Per month", width: 70, align: "right", cell: (r) => ({ text: r.cells[3], bold: true, color: C.ink }) },
    ],
    [
      { service: "API server (Render web service)", cells: web, disk: "—" },
      { service: "Database (Render PostgreSQL)", cells: db, disk: has(plans.db?.storageMb) ? fmtMb(plans.db.storageMb) : "—" },
      { service: "Total", cells: ["", "", "", plans.web?.current || plans.db?.current ? `$${fmtNum(total)}` : "—"], disk: "", total: true },
    ]
  );

  const lines = [];
  if (!plans.web?.current && !plans.db?.current) {
    lines.push("Plans weren't configured on the server when this report was saved (RENDER_WEB_PLAN / RENDER_DB_PLAN), so no upgrade can be named.");
  }
  if (prevPlans) {
    for (const [key, label] of [["web", "API server"], ["db", "Database"]]) {
      const before = prevPlans[key]?.current?.code;
      const now = plans[key]?.current?.code;
      if (before && now && before !== now) lines.push(`Plan change since ${ref.label}: ${label} ${before} to ${now}.`);
    }
  }
  const suggestions = [
    ["API server", plans.web],
    ["Database", plans.db],
  ].filter(([, p]) => p?.next && p?.current);
  for (const [label, p] of suggestions) {
    const what = p.upgradeFor === "cpu" ? "CPU" : "memory";
    lines.push(`Suggested: ${label} ${p.current.code} to ${p.next.code} for more ${what} (+$${p.monthlyDelta}/mo, new total $${total + p.monthlyDelta}/mo).`);
  }
  if (plans.db?.upgradeFor === "disk") lines.push("Suggested: increase the database disk or clean up old data; the database plan itself is fine.");
  const provisional = [ctx.data.capacity?.server, ctx.data.capacity?.database].some((g) => g?.provisional === "upgrade");
  if (provisional) {
    const cov = ctx.data.capacity?.coverage;
    lines.push(`An upgrade would be recommended, but it's held back as provisional until ${cov?.minimumDays ?? 14} days of history exist (${fmtNum(cov?.historyDays, 1)} so far).`);
  }
  if (!suggestions.length && !provisional && plans.db?.upgradeFor !== "disk") lines.push("No plan change is suggested for this period.");
  bullets(w, lines);
}

function metricsTable(w, rows) {
  table(
    w,
    [
      { label: "Metric", width: 196, cell: (r) => ({ text: r.label, color: C.ink }) },
      { label: "Value", width: 130, align: "right", cell: (r) => ({ text: r.value, bold: true, color: C.ink }) },
      { label: "Rating", width: 84, align: "right", cell: (r) => (BAND[r.band] ? { pill: BAND[r.band] } : { text: "—", color: C.faint }) },
      { label: "Aim for", width: 106, align: "right", cell: (r) => ({ text: r.spec ? aimFor(r.spec) : "—", color: C.muted }) },
    ],
    rows
  );
}

const provisionalNote = (gauge) =>
  gauge?.provisional === "upgrade" ? "Would be Upgrade, but held back as provisional: fewer than 14 days of history." : null;

function serverSection(w, ctx) {
  const s = ctx.data.capacity?.server || {};
  const t = ctx.thresholds.server || {};
  sectionTitle(w, "API server (Render)", s.verdict, provisionalNote(s));
  metricsTable(w, [
    { label: "CPU, 95th percentile", value: fmtValue(s.cpu?.p95Percent, "%"), band: s.cpu?.band, spec: t.cpuP95Percent },
    {
      label: "Memory, 95th percentile",
      value: has(s.memory?.p95Mb) ? `${fmtNum(s.memory.p95Mb)} MB${has(s.memory.p95PercentOfLimit) ? ` (${s.memory.p95PercentOfLimit}%)` : ""}` : "—",
      band: s.memory?.band,
      spec: t.memoryP95Percent,
    },
    { label: "Event-loop delay, 95th percentile", value: fmtValue(s.eventLoop?.p95Ms, "ms"), band: s.eventLoop?.band, spec: t.eventLoopP95Ms },
    { label: "Peak requests in progress at once", value: fmtNum(s.inFlight?.max) },
    { label: "Restarts (deploys count too)", value: fmtNum(s.restarts) },
  ]);
  subTitle(w, "Findings");
  bullets(w, s.reasons, "No issues found.");
  chart(w, {
    title: "Daily CPU and memory, 95th percentile",
    days: ctx.data.daily || [],
    unit: "%",
    fixedMax: 100,
    series: [
      { key: "cpuP95", label: "CPU", color: C.brand },
      { key: "memoryP95Percent", label: "Memory (of limit)", color: C.series2 },
    ],
    guides: t.cpuP95Percent
      ? [
          { value: t.cpuP95Percent.bounds[1], label: `CPU watch ${t.cpuP95Percent.bounds[1]}%`, color: BAND.watch.fg },
          { value: t.cpuP95Percent.bounds[2], label: `CPU terrible ${t.cpuP95Percent.bounds[2]}%`, color: BAND.terrible.fg },
        ]
      : [],
  });
}

function databaseSection(w, ctx) {
  const d = ctx.data.capacity?.database || {};
  const t = ctx.thresholds.database || {};
  sectionTitle(w, "Database (PostgreSQL)", d.verdict, provisionalNote(d));
  metricsTable(w, [
    { label: "Trivial query (SELECT 1), 95th percentile", value: fmtValue(d.latency?.p95Ms, "ms"), band: d.latency?.band, spec: t.latencyP95Ms },
    {
      label: "Connections, peak",
      value: has(d.connections?.peak) ? `${d.connections.peak} of ${d.connections.max} (${d.connections.peakPercent}%)` : "—",
      band: d.connections?.band,
      spec: t.connectionsPeakPercent,
    },
    { label: "Pool timeouts", value: fmtNum(d.poolTimeouts), band: d.poolTimeoutsBand, spec: t.poolTimeouts },
    { label: "Cache hit, when saved", value: fmtValue(d.cacheHitPercent, "%"), band: d.cacheHitBand, spec: t.cacheHitPercent },
    {
      label: "Size, when saved",
      value: has(d.storage?.sizeMb)
        ? `${fmtMb(d.storage.sizeMb)}${has(d.storage.limitMb) ? ` of ${fmtMb(d.storage.limitMb)} (${d.storage.percent}%)` : ""}`
        : "—",
      band: d.storage?.band,
      spec: t.storagePercent,
    },
  ]);
  subTitle(w, "Findings");
  bullets(w, d.reasons, "No issues found.");
  const latency = t.latencyP95Ms;
  chart(w, {
    title: "Daily trivial-query latency, 95th percentile",
    days: ctx.data.daily || [],
    unit: "ms",
    series: [{ key: "dbLatencyP95", label: "SELECT 1", color: C.brand }],
    guides: latency
      ? [
          { value: latency.bounds[1], label: `Watch ${latency.bounds[1]} ms`, color: BAND.watch.fg },
          { value: latency.bounds[2], label: `Terrible ${latency.bounds[2]} ms`, color: BAND.terrible.fg },
        ]
      : [],
  });
}

const KIND = { light: "Light", heavy: "Heavy", long: "Long" };

function hotspotsSection(w, ctx) {
  const h = ctx.data.capacity?.hotspots || {};
  const endpoints = (h.endpoints || []).slice(0, 15);
  const base = ctx.baseData ? new Map((ctx.baseData.capacity?.hotspots?.endpoints || []).map((e) => [`${e.method} ${e.endpoint}`, e.p95Ms])) : null;
  const changeCell = (pct, band) =>
    has(pct)
      ? {
          text: `${pct > 0 ? "+" : ""}${pct}%`,
          color: band === "terrible" ? BAND.terrible.fg : band === "watch" ? BAND.watch.fg : pct < 0 ? BETTER : C.muted,
        }
      : { text: "—", color: C.faint };
  const changeBand = (pct) => {
    const spec = ctx.thresholds.endpoints?.changePercent;
    if (!has(pct) || !spec) return null;
    return pct >= spec.bounds[2] ? "terrible" : pct >= spec.bounds[1] ? "watch" : null;
  };
  sectionTitle(w, "Traffic & API hotspots", h.verdict);
  chart(w, {
    title: "Requests per day",
    days: ctx.data.daily || [],
    unit: "count",
    type: "bar",
    height: 120,
    series: [{ key: "requests", label: "Requests", color: C.brand }],
  });
  subTitle(w, `Top ${endpoints.length} endpoints by total server time`);
  if (!endpoints.length) {
    paragraph(w, "No requests in this period.", { color: C.muted });
  } else {
    table(
      w,
      [
        { label: "Endpoint", width: base ? 186 : 244, cell: (e) => ({ text: `${e.method} ${e.endpoint}`, mono: true, color: C.ink, size: 7.5 }) },
        { label: "Kind", width: 44, cell: (e) => ({ text: KIND[e.class] || e.class || "—", color: C.muted }) },
        { label: "Calls", width: 52, align: "right", cell: (e) => ({ text: fmtNum(e.calls) }) },
        {
          label: "p95",
          width: 56,
          align: "right",
          cell: (e) => ({ text: fmtMs(e.p95Ms), bold: e.band === "terrible", color: BAND[e.band]?.fg || C.text }),
        },
        { label: "vs prior 30d", width: 58, align: "right", cell: (e) => changeCell(e.p95ChangePercent, e.changeBand) },
        ...(base
          ? [
              {
                label: "vs Baseline",
                width: 58,
                align: "right",
                cell: (e) => {
                  const before = base.get(`${e.method} ${e.endpoint}`);
                  const pct = before ? Math.round(((e.p95Ms - before) / before) * 100) : null;
                  return changeCell(pct, changeBand(pct));
                },
              },
            ]
          : []),
        { label: "Share", width: 62, align: "right", cell: (e) => ({ text: `${fmtNum(e.shareOfServerTimePercent, 1)}%` }) },
      ],
      endpoints,
      { size: 8 }
    );
    paragraph(w, "p95 is coloured by its band for the kind of endpoint: a light read should be far faster than a long sync or import. \"vs prior 30d\" compares with the 30 days before this report.", {
      size: 8,
      color: C.muted,
    });
  }
  subTitle(w, "Findings");
  bullets(w, h.reasons, "No slow or regressing endpoints.");
}

const LEGEND_ROWS = [
  ["server", "cpuP95Percent", "API server CPU, p95"],
  ["server", "memoryP95Percent", "API server memory, p95 of limit"],
  ["server", "eventLoopP95Ms", "Event-loop delay, p95"],
  ["database", "latencyP95Ms", "Trivial query latency, p95"],
  ["database", "connectionsPeakPercent", "Connections peak, of max"],
  ["database", "poolTimeouts", "Pool timeouts"],
  ["database", "cacheHitPercent", "Cache hit"],
  ["database", "storagePercent", "Storage, of disk"],
  ["endpoints", "light", "Light endpoint p95"],
  ["endpoints", "heavy", "Heavy endpoint p95"],
  ["endpoints", "long", "Long action p95"],
  ["endpoints", "changePercent", "Endpoint p95 change"],
];

function appendix(w, ctx) {
  w.doc.addPage();
  w.y = TOP;
  sectionTitle(w, "How to read this report");
  bullets(w, [
    "Every figure has a rating: Excellent, Good, Watch or Terrible. Watch means keep an eye on it; Terrible means act on it.",
    "Card verdicts are OK, Watch or Upgrade. Upgrade is only given when a bigger plan would actually help, and it stays provisional until 14 days of history exist.",
    "API server and database figures come from 5-minute samples taken on Render. Traffic and endpoint figures come from the request log of every API call. Cache hit and size are read when the report is saved.",
    "Heavy endpoints are approvals, timelogs, leaves, reports and payroll screens; long actions are syncs, imports, bulk jobs, PDFs and exports; everything else is light.",
    "The Baseline is the 30 days before production's database connection moved to Render's Internal URL. After it, every report covers exactly 30 days and is compared with the period before it and with the Baseline.",
    `Days in charts and dates run on ${ctx.timezone} time. A finished report is saved once and doesn't change afterwards, so reports stay comparable.`,
  ]);
  subTitle(w, "Rating thresholds used for this report");
  const rows = LEGEND_ROWS.filter(([g, k]) => ctx.thresholds[g]?.[k]).map(([g, k, label]) => ({
    label,
    cells: bandCells(ctx.thresholds[g][k]),
  }));
  const bandCol = (i, band) => ({
    label: BAND[band].label,
    width: 80,
    align: "right",
    cell: (r) => ({ text: r.cells[i], color: r.cells[i] === "—" ? C.faint : BAND[band].fg }),
  });
  table(w, [{ label: "Metric", width: 196, cell: (r) => ({ text: r.label, color: C.ink }) }, bandCol(0, "excellent"), bandCol(1, "good"), bandCol(2, "watch"), bandCol(3, "terrible")], rows);
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{ report: object, previous?: object|null, baseline?: object|null, timezone?: string }} snapshots
 *   CapacityReport rows: the report, the period before it (from Period 2) and the Baseline (from Period 1)
 * @returns {Promise<Buffer>}
 */
function generateCapacityReportPDF({ report, previous = null, baseline = null, timezone = "America/Los_Angeles" }) {
  return new Promise((resolve, reject) => {
    try {
      const tz = timezone;
      const data = report.data || {};
      const cov = data.capacity?.coverage;
      const isBaseline = report.number === 0;
      const reportLabel = isBaseline ? "Baseline" : `Period ${report.number}`;
      const first = moment(report.periodStart).tz(tz);
      const last = moment(report.periodEnd).tz(tz).subtract(1, "millisecond");
      const rangeLabel = `${first.format("MMM D")} – ${last.format("MMM D, YYYY")}`;
      const generatedAt = moment(data.generatedAt || report.updatedAt).tz(tz);
      const refs = [
        ...(previous?.data ? [{ label: `Period ${previous.number}`, data: previous.data }] : []),
        ...(baseline?.data ? [{ label: "Baseline", data: baseline.data }] : []),
      ];

      const ctx = {
        data,
        refs,
        baseData: baseline?.data || null,
        isBaseline,
        missingPrevious: report.number > 1 && !previous ? `Period ${report.number - 1}` : null,
        partial: report.isPartial,
        timezone: tz,
        thresholds: data.capacity?.thresholds || {},
        reportLabel,
        rangeLabel,
        headline: isBaseline ? `Before the database URL change · ${rangeLabel}` : `${reportLabel} · ${rangeLabel}`,
        periodLabel: `${first.format("MMM D, YYYY h:mm A")} – ${moment(report.periodEnd).tz(tz).format("MMM D, YYYY h:mm A z")}${report.isPartial ? " (to date)" : ""}`,
        generatedLabel: `${generatedAt.format("MMM D, YYYY, h:mm A z")} by ${report.generatedBy || (report.generatedById ? "a system admin" : "the scheduled job")}`,
        dataLabel: cov?.samples
          ? `${fmtNum(cov.samples)} five-minute samples over ${fmtNum(cov.coveredDays, 1)} days, plus the request log for the whole period`
          : "No five-minute samples for this period; traffic and endpoint figures come from the request log",
      };

      const doc = new PDFDocument({
        size: "LETTER",
        margin: 0,
        bufferPages: true,
        info: {
          Title: `BizBuddy Performance Report — ${reportLabel} (${rangeLabel})`,
          Author: "BizBuddy",
          Subject: "Infrastructure & performance, compared with the Baseline",
        },
      });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const w = { doc, y: 0 };
      cover(w, ctx);
      executiveSummary(w, ctx);
      plansSection(w, ctx);
      serverSection(w, ctx);
      databaseSection(w, ctx);
      hotspotsSection(w, ctx);
      appendix(w, ctx);

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        if (i > range.start) runningHeader(doc, ctx);
        footer(doc, ctx, i - range.start + 1, range.count);
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateCapacityReportPDF };
