// src/utils/generateCapacityReportPDF.js
//
// BB-113: a Performance report as a US Letter PDF (PDFKit). Drawn only from
// saved CapacityReport snapshots — the report itself, the period before it and
// the Baseline — so a report never changes after the fact.
//
// BB-119: uses the shared report layout (@utils/pdf/reportLayout) and is the
// only "Internal" report. It also prints figures the snapshot already saves but
// the first version left out: CPU average and time at 80%+, memory peak and
// limit, time with a slow event loop, requests in progress (p95), per-endpoint
// average / slow calls / 5xx, and the daily p95 and 5xx series. Older snapshots
// that lack a figure show "—" or "Not recorded for this period".

const moment = require("moment-timezone");
const L = require("@utils/pdf/reportLayout");

const { THEME, PILL, safe, font } = L;

const SERIES2 = "#475569";

const BAND = {
  excellent: { label: "Excellent", ...PILL.ok },
  good: { label: "Good", ...PILL.ok },
  watch: { label: "Watch", ...PILL.warn },
  terrible: { label: "Terrible", ...PILL.bad },
};
const VERDICT = {
  ok: { label: "OK", ...PILL.ok },
  watch: { label: "Watch", ...PILL.warn },
  upgrade: { label: "Upgrade", ...PILL.bad },
};
const BETTER = PILL.ok.fg;
const WORSE = PILL.bad.fg;

// ── Text and numbers ────────────────────────────────────────────────────────

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
  if (!has(now) || !has(before)) return { text: "—", color: THEME.faint };
  const diff = Number(now) - Number(before);
  const rel = Number(before) ? (diff / Math.abs(Number(before))) * 100 : null;
  const tiny = unit === "%" ? Math.abs(diff) < 0.5 : rel == null ? diff === 0 : Math.abs(rel) < 2;
  if (tiny) return { text: "no change", color: THEME.muted };
  const sign = diff > 0 ? "+" : "-";
  const text =
    unit === "%" ? `${sign}${fmtNum(Math.abs(diff), 1)} pts` : rel == null ? `${sign}${fmtNum(Math.abs(diff))}` : `${sign}${fmtNum(Math.abs(rel))}%`;
  const improved = better === "lower" ? diff < 0 : better === "higher" ? diff > 0 : null;
  return { text, color: improved == null ? THEME.muted : improved ? BETTER : WORSE };
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
const zeroish = (v) => has(v) && Number(v) === 0;

// ── Charts ──────────────────────────────────────────────────────────────────

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
  const { doc, left, width } = w;
  L.ensure(w, height + 22);
  font(doc, "Helvetica-Bold", 9, THEME.ink).text(safe(title), left, w.y, { lineBreak: false });
  let lx = left + width;
  for (const s of [...series].reverse()) {
    font(doc, "Helvetica", 7.5, THEME.muted);
    lx -= doc.widthOfString(s.label);
    doc.text(s.label, lx, w.y + 1, { lineBreak: false });
    lx -= 13;
    doc.rect(lx, w.y + 3.5, 9, 3).fill(s.color);
    lx -= 12;
  }
  w.y += 16;

  const box = { x: left + 40, y: w.y + 4, w: width - 40, h: height - 26 };
  const values = series.flatMap((s) => days.map((d) => d[s.key])).filter(has).map(Number);
  if (!values.length) {
    doc.roundedRect(left, box.y, width, box.h, L.mm(1.2)).fill(THEME.fill);
    font(doc, "Helvetica", 9, THEME.muted).text("Not recorded for this period.", left, box.y + box.h / 2 - 5, { width, align: "center" });
    w.y += height;
    return;
  }

  const max = fixedMax ?? niceMax(Math.max(...values, ...guides.map((g) => g.value)) * 1.1);
  const yOf = (v) => box.y + box.h - (Math.min(v, max) / max) * box.h;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const gy = yOf(v);
    doc.moveTo(box.x, gy).lineTo(box.x + box.w, gy).lineWidth(0.5).strokeColor(THEME.rule).stroke();
    font(doc, "Helvetica", 6.8, THEME.muted).text(axisLabel(v, unit), left, gy - 3.5, { width: 34, align: "right", lineBreak: false });
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

  doc.moveTo(box.x, box.y + box.h).lineTo(box.x + box.w, box.y + box.h).lineWidth(0.8).strokeColor(THEME.faint).stroke();
  const every = Math.ceil(days.length / 8);
  days.forEach((d, i) => {
    if (i % every) return;
    font(doc, "Helvetica", 6.8, THEME.muted).text(moment(d.day, "YYYY-MM-DD").format("MMM D"), xOf(i) - 20, box.y + box.h + 5, {
      width: 40,
      align: "center",
      lineBreak: false,
    });
  });
  w.y += height + 8;
}

// ── First page ──────────────────────────────────────────────────────────────

function cover(w, ctx) {
  L.title(w, ctx.isBaseline ? "Baseline Report" : "Performance Report", `${ctx.headline}${ctx.partial ? " · to date" : ""}`);
  L.metaStrip(w, [
    { label: "Period", value: ctx.periodLabel, sub: ctx.partial ? "Still running, figures to date" : null },
    { label: "Generated", value: ctx.generatedAtLabel, sub: `by ${ctx.generatedBy}` },
    { label: "Times shown in", value: `${L.zoneCity(ctx.timezone)} time`, sub: ctx.timezone },
    { label: "Data", value: ctx.dataLabel },
  ]);
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
  const cap = ctx.data.capacity || {};
  const ref = ctx.refs[ctx.refs.length - 1]; // the Baseline when there is one
  const plans = cap.plans || {};
  const monthly = (plans.web?.current?.monthly ?? null) != null || (plans.db?.current?.monthly ?? null) != null
    ? (plans.web?.current?.monthly || 0) + (plans.db?.current?.monthly || 0)
    : null;
  const tile = (metric, band, label) => {
    const now = metric.get(ctx.data);
    const change = ref ? fmtChange(now, metric.get(ref.data), metric.unit, metric.better) : null;
    if (change && change.text !== "—") return { label, value: fmtValue(now, metric.unit), sub: `${change.text} vs ${ref.label}`, subColor: change.color };
    return { label, value: fmtValue(now, metric.unit), sub: band ? BAND[band]?.label || "" : "", subColor: band ? BAND[band]?.fg : THEME.muted };
  };
  L.kpiTiles(w, [
    tile(COMPARE[0], cap.server?.cpu?.band, "API CPU, p95"),
    tile(COMPARE[3], cap.database?.latency?.band, "DB latency, p95"),
    tile(COMPARE[10], null, "Endpoints flagged"),
    {
      label: "Hosting / month",
      value: monthly == null ? "—" : `$${fmtNum(monthly)}`,
      sub: monthly == null ? "Plans not configured" : `API $${plans.web?.current?.monthly ?? "?"} + database $${plans.db?.current?.monthly ?? "?"}`,
    },
  ]);
}

function executiveSummary(w, ctx) {
  const { doc, left, width } = w;
  const cap = ctx.data.capacity || {};
  L.sectionTitle(w, "Executive summary");

  const rec = safe(cap.recommendation || "No recommendation.");
  font(doc, "Helvetica-Bold", 9.5, THEME.ink);
  const recW = width - 96;
  const recH = doc.heightOfString(rec, { width: recW });
  const panelH = Math.max(recH + 20, 40);
  L.ensure(w, panelH + 8);
  doc.rect(left, w.y, width, panelH).fill(THEME.tint);
  doc.rect(left, w.y, L.mm(1.2), panelH).fill(THEME.orange);
  L.pill(doc, VERDICT[cap.overall] || VERDICT.ok, left + 14, w.y + panelH / 2 - L.mm(2.2));
  font(doc, "Helvetica-Bold", 9.5, THEME.ink).text(rec, left + 84, w.y + (panelH - recH) / 2, { width: recW });
  w.y += panelH + L.mm(4);

  kpiTiles(w, ctx);

  L.subTitle(w, ctx.refs.length ? `Compared with ${ctx.refs.map((r) => r.label).join(" and the ")}` : "Key figures");
  L.table(
    w,
    [
      { label: "Metric", width: null, cell: (m) => ({ text: m.label }) },
      { label: ctx.reportLabel + (ctx.partial ? " (to date)" : ""), width: 86, align: "right", cell: (m) => ({ text: fmtValue(m.get(ctx.data), m.unit), bold: true }) },
      ...ctx.refs.flatMap((r) => [
        { label: r.label, width: 76, align: "right", cell: (m) => ({ text: fmtValue(m.get(r.data), m.unit), color: THEME.muted }) },
        { label: "Change", width: 66, align: "right", cell: (m) => fmtChange(m.get(ctx.data), m.get(r.data), m.unit, m.better) },
      ]),
    ],
    COMPARE
  );
  const notes = [];
  if (ctx.isBaseline) notes.push("This is the Baseline: every later report is compared with it.");
  else if (ctx.missingPrevious) notes.push(`${ctx.missingPrevious} isn't saved, so only the Baseline comparison is shown.`);
  if (ctx.partial) notes.push("This period is still running: requests, server time and errors cover only part of it, so they read lower than a full period.");
  if (ctx.refs.length) notes.push("Green changes are improvements and red changes are regressions; grey rows depend on traffic and are neither.");
  for (const n of notes) L.paragraph(w, n, { size: 7.5, color: THEME.muted, gapAfter: 3 });
}

const planCells = (p) =>
  p
    ? [p.code, `${fmtNum(p.cpu, 1)} CPU`, p.ramMb >= 1024 ? `${fmtNum(p.ramMb / 1024)} GB` : `${p.ramMb} MB`, `$${fmtNum(p.monthly)}`]
    : ["Not configured", "—", "—", "—"];

function plansSection(w, ctx) {
  const plans = ctx.data.capacity?.plans || {};
  const ref = ctx.refs[0];
  const prevPlans = ref?.data?.capacity?.plans;
  L.sectionTitle(w, "Hosting plans & cost");

  const web = planCells(plans.web?.current);
  const db = planCells(plans.db?.current);
  const total = (plans.web?.current?.monthly || 0) + (plans.db?.current?.monthly || 0);
  L.table(
    w,
    [
      { label: "Service", width: null, cell: (r) => ({ text: r.service }) },
      { label: "Plan", width: 96, cell: (r) => ({ text: r.cells[0], mono: !r.total }) },
      { label: "CPU", width: 64, align: "right", cell: (r) => ({ text: r.cells[1] }) },
      { label: "Memory", width: 68, align: "right", cell: (r) => ({ text: r.cells[2] }) },
      { label: "Disk", width: 68, align: "right", cell: (r) => ({ text: r.disk }) },
      { label: "Per month", width: 70, align: "right", cell: (r) => ({ text: r.cells[3], bold: true }) },
    ],
    [
      { service: "API server (Render web service)", cells: web, disk: "—" },
      { service: "Database (Render PostgreSQL)", cells: db, disk: has(plans.db?.storageMb) ? fmtMb(plans.db.storageMb) : "—" },
      { service: "Total", cells: ["", "", "", plans.web?.current || plans.db?.current ? `$${fmtNum(total)}` : "—"], disk: "", total: true },
    ],
    { isTotal: (r) => r.total }
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
  L.bullets(w, lines);
}

function metricsTable(w, rows) {
  L.table(
    w,
    [
      { label: "Metric", width: null, cell: (r) => ({ text: r.label }) },
      { label: "Value", width: 136, align: "right", cell: (r) => ({ text: r.value, bold: !r.detail, color: r.value === "—" ? THEME.faint : THEME.ink }) },
      { label: "Rating", width: 76, align: "right", cell: (r) => (BAND[r.band] ? { pill: BAND[r.band] } : { text: "—", color: THEME.faint }) },
      { label: "Aim for", width: 96, align: "right", cell: (r) => ({ text: r.spec ? aimFor(r.spec) : "—", color: r.spec ? THEME.muted : THEME.faint }) },
    ],
    rows
  );
}

const provisionalNote = (gauge) =>
  gauge?.provisional === "upgrade" ? "Would be Upgrade, but held back as provisional: fewer than 14 days of history." : null;

function serverSection(w, ctx) {
  const s = ctx.data.capacity?.server || {};
  const t = ctx.thresholds.server || {};
  const sampled = (ctx.data.capacity?.coverage?.samples || 0) > 0;
  const shareOfTime = (v) => (sampled && has(v) ? `${fmtNum(v)}% of the time` : "—");
  L.sectionTitle(w, "API server (Render)", { pill: VERDICT[s.verdict] });
  const note = provisionalNote(s);
  if (note) L.paragraph(w, note, { size: 8, color: PILL.warn.fg });
  metricsTable(w, [
    { label: "CPU, 95th percentile", value: fmtValue(s.cpu?.p95Percent, "%"), band: s.cpu?.band, spec: t.cpuP95Percent },
    { label: "CPU, average", value: fmtValue(s.cpu?.avgPercent, "%"), detail: true },
    { label: "Time at 80%+ CPU", value: shareOfTime(s.cpu?.hotSharePercent), detail: true },
    {
      label: "Memory, 95th percentile",
      value: has(s.memory?.p95Mb) ? `${fmtNum(s.memory.p95Mb)} MB${has(s.memory.p95PercentOfLimit) ? ` (${s.memory.p95PercentOfLimit}%)` : ""}` : "—",
      band: s.memory?.band,
      spec: t.memoryP95Percent,
    },
    {
      label: "Memory, peak",
      value: has(s.memory?.maxMb) ? `${fmtNum(s.memory.maxMb)} MB${has(s.memory.limitMb) ? ` of ${fmtNum(s.memory.limitMb)} MB` : ""}` : "—",
      detail: true,
    },
    { label: "Event-loop delay, 95th percentile", value: fmtValue(s.eventLoop?.p95Ms, "ms"), band: s.eventLoop?.band, spec: t.eventLoopP95Ms },
    { label: "Time with event-loop delay 200 ms+", value: shareOfTime(s.eventLoop?.slowSharePercent), detail: true },
    { label: "Requests in progress at once, 95th percentile", value: fmtNum(s.inFlight?.p95, 1), detail: true },
    { label: "Requests in progress at once, peak", value: fmtNum(s.inFlight?.max) },
    { label: "Restarts (deploys count too)", value: fmtNum(s.restarts) },
  ]);
  L.subTitle(w, "Findings");
  L.bullets(w, s.reasons, "No issues found.");
  chart(w, {
    title: "Daily CPU and memory, 95th percentile",
    days: ctx.data.daily || [],
    unit: "%",
    fixedMax: 100,
    series: [
      { key: "cpuP95", label: "CPU", color: THEME.orange },
      { key: "memoryP95Percent", label: "Memory (of limit)", color: SERIES2 },
    ],
    guides: t.cpuP95Percent
      ? [
          { value: t.cpuP95Percent.bounds[1], label: `CPU watch ${t.cpuP95Percent.bounds[1]}%`, color: PILL.warn.fg },
          { value: t.cpuP95Percent.bounds[2], label: `CPU terrible ${t.cpuP95Percent.bounds[2]}%`, color: PILL.bad.fg },
        ]
      : [],
  });
}

function databaseSection(w, ctx) {
  const d = ctx.data.capacity?.database || {};
  const t = ctx.thresholds.database || {};
  L.sectionTitle(w, "Database (PostgreSQL)", { pill: VERDICT[d.verdict] });
  const note = provisionalNote(d);
  if (note) L.paragraph(w, note, { size: 8, color: PILL.warn.fg });
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
  L.subTitle(w, "Findings");
  L.bullets(w, d.reasons, "No issues found.");
  const latency = t.latencyP95Ms;
  chart(w, {
    title: "Daily trivial-query latency, 95th percentile",
    days: ctx.data.daily || [],
    unit: "ms",
    series: [{ key: "dbLatencyP95", label: "SELECT 1", color: THEME.orange }],
    guides: latency
      ? [
          { value: latency.bounds[1], label: `Watch ${latency.bounds[1]} ms`, color: PILL.warn.fg },
          { value: latency.bounds[2], label: `Terrible ${latency.bounds[2]} ms`, color: PILL.bad.fg },
        ]
      : [],
  });
}

const KIND = { light: "Light", heavy: "Heavy", long: "Long" };

function hotspotsSection(w, ctx) {
  const h = ctx.data.capacity?.hotspots || {};
  const all = h.endpoints || [];
  const endpoints = all.slice(0, 15);
  const base = ctx.baseData ? new Map((ctx.baseData.capacity?.hotspots?.endpoints || []).map((e) => [`${e.method} ${e.endpoint}`, e.p95Ms])) : null;
  const changeCell = (pct, band) =>
    has(pct)
      ? {
          text: `${pct > 0 ? "+" : ""}${pct}%`,
          color: band === "terrible" ? PILL.bad.fg : band === "watch" ? PILL.warn.fg : pct < 0 ? BETTER : THEME.muted,
        }
      : { text: "—", color: THEME.faint };
  const changeBand = (pct) => {
    const spec = ctx.thresholds.endpoints?.changePercent;
    if (!has(pct) || !spec) return null;
    return pct >= spec.bounds[2] ? "terrible" : pct >= spec.bounds[1] ? "watch" : null;
  };
  const days = ctx.data.daily || [];

  L.sectionTitle(w, "Traffic & API hotspots", { pill: VERDICT[h.verdict] });
  chart(w, {
    title: "Requests per day",
    days,
    unit: "count",
    type: "bar",
    height: 120,
    series: [{ key: "requests", label: "Requests", color: THEME.orange }],
  });
  chart(w, {
    title: "Daily API response time, 95th percentile (all requests)",
    days,
    unit: "ms",
    height: 120,
    series: [{ key: "p95Ms", label: "p95", color: SERIES2 }],
  });
  const errorDays = days.filter((d) => has(d.serverErrors));
  if (errorDays.length && sum(errorDays, "serverErrors") === 0) {
    L.subTitle(w, "Server errors (5xx) per day");
    L.paragraph(w, "No server errors (5xx) in this period.", { size: 8.5, color: THEME.muted });
  } else {
    chart(w, {
      title: "Server errors (5xx) per day",
      days,
      unit: "count",
      type: "bar",
      height: 110,
      series: [{ key: "serverErrors", label: "5xx", color: PILL.bad.fg }],
    });
  }

  L.subTitle(w, `Top ${endpoints.length} endpoints by total server time`);
  if (!endpoints.length) {
    L.paragraph(w, "No requests in this period.", { color: THEME.muted });
  } else {
    L.table(
      w,
      [
        { label: "Endpoint", width: null, cell: (e) => ({ text: `${e.method} ${e.endpoint}`, mono: true, size: 7 }) },
        { label: "Kind", width: 38, cell: (e) => ({ text: KIND[e.class] || e.class || "—", color: THEME.muted }) },
        { label: "Calls", width: 46, align: "right", cell: (e) => ({ text: fmtNum(e.calls) }) },
        { label: "Avg", width: 46, align: "right", cell: (e) => ({ text: fmtMs(e.avgMs), color: has(e.avgMs) ? THEME.ink : THEME.faint }) },
        {
          label: "p95",
          width: 48,
          align: "right",
          cell: (e) => ({ text: fmtMs(e.p95Ms), bold: e.band === "terrible", color: isBadBand(e.band) ? BAND[e.band].fg : THEME.ink }),
        },
        { label: "vs prior 30d", width: 56, align: "right", cell: (e) => changeCell(e.p95ChangePercent, e.changeBand) },
        ...(base
          ? [
              {
                label: "vs Baseline",
                width: 56,
                align: "right",
                cell: (e) => {
                  const before = base.get(`${e.method} ${e.endpoint}`);
                  const pct = before ? Math.round(((e.p95Ms - before) / before) * 100) : null;
                  return changeCell(pct, changeBand(pct));
                },
              },
            ]
          : []),
        { label: "Share", width: 44, align: "right", cell: (e) => ({ text: `${fmtNum(e.shareOfServerTimePercent, 1)}%` }) },
      ],
      endpoints,
      { striped: true }
    );
    L.paragraph(w, "p95 is coloured when it's Watch or Terrible for the kind of endpoint: a light read should be far faster than a long sync or import. \"vs prior 30d\" compares with the 30 days before this report.", {
      size: 7.5,
      color: THEME.muted,
    });
  }

  // Slow calls (over 1 second) and 5xx errors among the busiest endpoints.
  L.subTitle(w, "Slow calls and server errors");
  const recorded = all.some((e) => e.slowCalls !== undefined || e.serverErrors !== undefined);
  const problems = all
    .filter((e) => (Number(e.slowCalls) || 0) > 0 || (Number(e.serverErrors) || 0) > 0)
    .sort((a, b) => (Number(b.serverErrors) || 0) - (Number(a.serverErrors) || 0) || (Number(b.slowCalls) || 0) - (Number(a.slowCalls) || 0))
    .slice(0, 10);
  if (!all.length) {
    L.paragraph(w, "No requests in this period.", { color: THEME.muted });
  } else if (!recorded) {
    L.paragraph(w, "Not recorded for this period.", { color: THEME.muted });
  } else if (!problems.length) {
    L.paragraph(w, `No slow calls or server errors among the ${all.length} busiest endpoints.`, { color: THEME.muted });
  } else {
    const count = (v) => (zeroish(v) ? { text: "0", color: THEME.faint } : { text: fmtNum(v), bold: true });
    L.table(
      w,
      [
        { label: "Endpoint", width: null, cell: (e) => ({ text: `${e.method} ${e.endpoint}`, mono: true, size: 7 }) },
        { label: "Calls", width: 56, align: "right", cell: (e) => ({ text: fmtNum(e.calls) }) },
        { label: "Slow (over 1 s)", width: 74, align: "right", cell: (e) => count(e.slowCalls) },
        {
          label: "Slow share",
          width: 60,
          align: "right",
          cell: (e) => (e.calls && has(e.slowCalls) ? { text: `${fmtNum((e.slowCalls / e.calls) * 100, 1)}%`, color: THEME.muted } : { text: "—", color: THEME.faint }),
        },
        { label: "5xx errors", width: 60, align: "right", cell: (e) => ({ ...count(e.serverErrors), color: zeroish(e.serverErrors) ? THEME.faint : PILL.bad.fg }) },
      ],
      problems,
      { striped: true }
    );
    L.paragraph(w, `From the ${all.length} busiest endpoints by server time. A slow call took over 1 second.`, { size: 7.5, color: THEME.muted });
  }

  L.subTitle(w, "Findings");
  L.bullets(w, h.reasons, "No slow or regressing endpoints.");
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
  L.newPage(w);
  L.sectionTitle(w, "How to read this report");
  L.bullets(w, [
    "Every figure has a rating: Excellent, Good, Watch or Terrible. Watch means keep an eye on it; Terrible means act on it.",
    "Card verdicts are OK, Watch or Upgrade. Upgrade is only given when a bigger plan would actually help, and it stays provisional until 14 days of history exist.",
    "API server and database figures come from 5-minute samples taken on Render. Traffic and endpoint figures come from the request log of every API call. Cache hit and size are read when the report is saved.",
    "\"Time at 80%+ CPU\" and \"Time with event-loop delay 200 ms+\" are the share of 5-minute samples above that level. A slow call is a request that took over 1 second.",
    "Heavy endpoints are approvals, timelogs, leaves, reports and payroll screens; long actions are syncs, imports, bulk jobs, PDFs and exports; everything else is light.",
    "The Baseline is the 30 days before production's database connection moved to Render's Internal URL. After it, every report covers exactly 30 days and is compared with the period before it and with the Baseline.",
    `Days in charts and dates run on ${L.zoneCity(ctx.timezone)} time (${ctx.timezone}). A finished report is saved once and doesn't change afterwards, so reports stay comparable.`,
  ]);
  L.subTitle(w, "Rating thresholds used for this report");
  const rows = LEGEND_ROWS.filter(([g, k]) => ctx.thresholds[g]?.[k]).map(([g, k, label]) => ({
    label,
    cells: bandCells(ctx.thresholds[g][k]),
  }));
  const bandCol = (i, band) => ({
    label: BAND[band].label,
    width: 80,
    align: "right",
    cell: (r) => ({ text: r.cells[i], color: r.cells[i] === "—" ? THEME.faint : BAND[band].fg }),
  });
  L.table(w, [{ label: "Metric", width: null, cell: (r) => ({ text: r.label }) }, bandCol(0, "excellent"), bandCol(1, "good"), bandCol(2, "watch"), bandCol(3, "terrible")], rows);
  L.endNote(w, ["Internal report for BizBuddy system administrators. Figures that a saved period didn't record are shown as \"—\"."]);
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{ report: object, previous?: object|null, baseline?: object|null, timezone?: string }} snapshots
 *   CapacityReport rows: the report, the period before it (from Period 2) and the Baseline (from Period 1)
 * @returns {Promise<Buffer>}
 */
function generateCapacityReportPDF({ report, previous = null, baseline = null, timezone = "America/Los_Angeles" }) {
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
    const reportName = isBaseline ? "Baseline Report" : "Performance Report";

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
      periodLabel: `${first.format("MMM D, YYYY h:mm A")} – ${moment(report.periodEnd).tz(tz).format("MMM D, YYYY h:mm A z")}`,
      generatedAtLabel: generatedAt.format("MMM D, YYYY, h:mm A z"),
      generatedBy: report.generatedBy || (report.generatedById ? "a system admin" : "the scheduled job"),
      dataLabel: cov?.samples
        ? `${fmtNum(cov.samples)} five-minute samples over ${fmtNum(cov.coveredDays, 1)} days, plus the request log for the whole period`
        : "No five-minute samples for this period; traffic and endpoint figures come from the request log",
    };

    const w = L.createReport({
      orientation: "portrait",
      tag: "internal",
      reportName,
      eyebrow: "Infrastructure & performance",
      generatedLabel: ctx.generatedAtLabel,
      continuation: { title: reportName, detail: `${reportLabel} · ${rangeLabel}` },
      info: {
        Title: `BizBuddy ${reportName} — ${reportLabel} (${rangeLabel})`,
        Subject: "Infrastructure & performance, compared with the Baseline",
      },
    });

    cover(w, ctx);
    executiveSummary(w, ctx);
    plansSection(w, ctx);
    serverSection(w, ctx);
    databaseSection(w, ctx);
    hotspotsSection(w, ctx);
    appendix(w, ctx);
    return L.finish(w);
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { generateCapacityReportPDF };
