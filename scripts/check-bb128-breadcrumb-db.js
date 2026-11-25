// scripts/check-bb128-breadcrumb-db.js
//
// BB-128: how the GPS breadcrumb table looks (2026-11-25).
//
// Reports:
//   1. Table size (rows, data, indexes, total) and each index's size.
//   2. Per company: setting on/off + interval, rows, punches, employees,
//      oldest / newest point, average points per punch, MB estimate.
//   3. Rows per day (company zone not applied: UTC days) for the last N days.
//   4. Data quality: accuracy buckets, foreground / background / unknown,
//      isMocked, batteryLevel filled, upload delay (receivedAt − recordedAt).
//   5. Retention: points older than 90 days (should be 0 once the nightly job ran).
//
// READ-ONLY: SELECTs only. Raw SQL, so it works with any generated Prisma client.
//
// Usage:
//   node scripts/check-bb128-breadcrumb-db.js
//   node scripts/check-bb128-breadcrumb-db.js --days 30 --company <companyId>
//
//   --days     rows-per-day window (default 14)
//   --company  one company for sections 2–4 (default: all)

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RETENTION_DAYS = 90; // same as services/Locations/breadcrumbService.js
const LOW_ACCURACY_METERS = 100; // same as the Employee Map distance rule

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const DAYS = Math.max(1, Math.min(90, Number(arg("days")) || 14));
const COMPANY = arg("company") || null;

const n = (v) => (v == null ? 0 : Number(v));
const mb = (bytes) => `${(n(bytes) / 1024 / 1024).toFixed(1)} MB`;
const pct = (part, whole) => (n(whole) ? `${((n(part) / n(whole)) * 100).toFixed(1)}%` : "-");
const iso = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + "Z" : "-");

async function main() {
  console.log(`BB-128 breadcrumb DB check${COMPANY ? ` (company ${COMPANY})` : ""}\n`);

  // 1. Size
  const [size] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*) FROM "LocationBreadcrumb")                       AS rows,
      pg_relation_size('"LocationBreadcrumb"')                          AS data_bytes,
      pg_indexes_size('"LocationBreadcrumb"')                           AS index_bytes,
      pg_total_relation_size('"LocationBreadcrumb"')                    AS total_bytes,
      pg_database_size(current_database())                              AS db_bytes`;
  const rows = n(size.rows);
  console.log("1. Table size");
  console.log(`   rows ${rows.toLocaleString()} | data ${mb(size.data_bytes)} | indexes ${mb(size.index_bytes)} | total ${mb(size.total_bytes)} (${pct(size.total_bytes, size.db_bytes)} of the whole DB, ${mb(size.db_bytes)})`);
  if (rows) console.log(`   ≈ ${Math.round(n(size.total_bytes) / rows)} bytes per row incl. indexes`);
  const indexes = await prisma.$queryRaw`
    SELECT indexrelname AS name, pg_relation_size(indexrelid) AS bytes, idx_scan AS scans
    FROM pg_stat_user_indexes WHERE relname = 'LocationBreadcrumb' ORDER BY 2 DESC`;
  for (const ix of indexes) console.log(`   index ${ix.name}: ${mb(ix.bytes)}, ${n(ix.scans).toLocaleString()} scans since stats reset`);

  // 2. Per company
  const companies = await prisma.$queryRaw`
    SELECT c.id, c.name, c."breadcrumbsEnabled" AS enabled, c."breadcrumbIntervalMinutes" AS interval,
           COUNT(b.id)                    AS rows,
           COUNT(DISTINCT b."timeLogId")  AS punches,
           COUNT(DISTINCT b."userId")     AS employees,
           MIN(b."recordedAt")            AS oldest,
           MAX(b."recordedAt")            AS newest
    FROM "Company" c
    LEFT JOIN "LocationBreadcrumb" b ON b."companyId" = c.id
    WHERE (c."breadcrumbsEnabled" = true OR b.id IS NOT NULL)
      AND (${COMPANY}::text IS NULL OR c.id = ${COMPANY})
    GROUP BY c.id ORDER BY COUNT(b.id) DESC`;
  console.log("\n2. Per company (setting on, or has points)");
  if (!companies.length) console.log("   none");
  const bytesPerRow = rows ? n(size.total_bytes) / rows : 0;
  for (const c of companies) {
    const avg = n(c.punches) ? (n(c.rows) / n(c.punches)).toFixed(1) : "-";
    console.log(`   ${c.name} (${c.id}) | ${c.enabled ? "ON" : "off"}, every ${c.interval} min`);
    console.log(`     rows ${n(c.rows).toLocaleString()} | punches ${n(c.punches)} | employees ${n(c.employees)} | avg ${avg} points/punch | ≈ ${mb(n(c.rows) * bytesPerRow)}`);
    console.log(`     oldest ${iso(c.oldest)} | newest ${iso(c.newest)}`);
  }

  // 3. Rows per day
  const perDay = await prisma.$queryRaw`
    SELECT to_char(date_trunc('day', "recordedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           COUNT(*) AS rows, COUNT(DISTINCT "timeLogId") AS punches, COUNT(DISTINCT "userId") AS employees
    FROM "LocationBreadcrumb"
    WHERE "recordedAt" >= now() - make_interval(days => ${DAYS}::int)
      AND (${COMPANY}::text IS NULL OR "companyId" = ${COMPANY})
    GROUP BY 1 ORDER BY 1`;
  console.log(`\n3. Rows per day, last ${DAYS} days (UTC days)`);
  if (!perDay.length) console.log("   none");
  for (const d of perDay) console.log(`   ${d.day}: ${n(d.rows).toLocaleString()} rows, ${n(d.punches)} punches, ${n(d.employees)} employees`);

  // 4. Data quality
  const [q] = await prisma.$queryRaw`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE accuracy IS NULL)                         AS acc_none,
           COUNT(*) FILTER (WHERE accuracy <= 20)                           AS acc_20,
           COUNT(*) FILTER (WHERE accuracy > 20 AND accuracy <= 50)         AS acc_50,
           COUNT(*) FILTER (WHERE accuracy > 50 AND accuracy <= ${LOW_ACCURACY_METERS}) AS acc_100,
           COUNT(*) FILTER (WHERE accuracy > ${LOW_ACCURACY_METERS})        AS acc_low,
           COUNT(*) FILTER (WHERE source = 'foreground')                    AS fg,
           COUNT(*) FILTER (WHERE source = 'background')                    AS bg,
           COUNT(*) FILTER (WHERE source IS NULL)                           AS src_none,
           COUNT(*) FILTER (WHERE "isMocked")                               AS mocked,
           COUNT(*) FILTER (WHERE "batteryLevel" IS NOT NULL)               AS battery,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("receivedAt" - "recordedAt"))) AS delay_p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("receivedAt" - "recordedAt"))) AS delay_p95,
           MAX(EXTRACT(EPOCH FROM ("receivedAt" - "recordedAt")))           AS delay_max
    FROM "LocationBreadcrumb"
    WHERE (${COMPANY}::text IS NULL OR "companyId" = ${COMPANY})`;
  const t = n(q.total);
  console.log("\n4. Data quality");
  console.log(`   accuracy: ≤20 m ${pct(q.acc_20, t)} | 20–50 m ${pct(q.acc_50, t)} | 50–${LOW_ACCURACY_METERS} m ${pct(q.acc_100, t)} | >${LOW_ACCURACY_METERS} m ${pct(q.acc_low, t)} (left out of map distance) | none ${pct(q.acc_none, t)}`);
  console.log(`   source: foreground ${pct(q.fg, t)} | background ${pct(q.bg, t)} | unknown ${pct(q.src_none, t)}`);
  console.log(`   isMocked: ${n(q.mocked).toLocaleString()} (${pct(q.mocked, t)})`);
  console.log(`   batteryLevel filled: ${n(q.battery).toLocaleString()} (${pct(q.battery, t)}; 0 expected before the 2026-11-25 fix is deployed)`);
  const sec = (v) => (v == null ? "-" : `${Math.round(Number(v))} s`);
  console.log(`   upload delay: median ${sec(q.delay_p50)} | 95% ${sec(q.delay_p95)} | max ${sec(q.delay_max)}`);

  // 5. Retention
  const [old] = await prisma.$queryRaw`
    SELECT COUNT(*) AS rows FROM "LocationBreadcrumb"
    WHERE "recordedAt" < now() - make_interval(days => ${RETENTION_DAYS}::int)`;
  console.log(`\n5. Retention: ${n(old.rows).toLocaleString()} point(s) older than ${RETENTION_DAYS} days (expected 0 after the nightly cleanup)`);
}

main()
  .catch((err) => {
    console.error("Check failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
