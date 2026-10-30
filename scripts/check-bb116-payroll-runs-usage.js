// scripts/check-bb116-payroll-runs-usage.js
//
// BB-116 follow-up — payrollController.computeEntryForUser (used by
// /api/payroll/runs) estimates paid leave as flat default-hours per calendar
// day, ignoring LeaveDay, unpaid leave and weekends. Before deciding whether it
// needs a rework, check RequestLog for whether anything still calls it.
//
// Sections:
//   1. /api/payroll/runs* calls by method + endpoint (count, first/last, failed)
//   2. Who called it — company, role, B. Buddy vs human, app vs browser
//   3. 20 most recent calls
//   4. Context — rest of /api/payroll/* (not -export / -system), and the
//      oldest RequestLog row (how far back history goes)
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb116-payroll-runs-usage.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const TZ = "America/Los_Angeles";
const RUNS_PREFIX = "/api/payroll/runs";
const PAYROLL_PREFIX = "/api/payroll/"; // trailing slash excludes /api/payroll-export, /api/payroll-system

function fmtLocal(d) {
  return d ? moment(d).tz(TZ).format("YYYY-MM-DD hh:mm A z") : "—";
}

function clientKind(ua) {
  if (!ua) return "unknown";
  if (/okhttp|Dart|CFNetwork|Expo|ReactNative|Darwin/i.test(ua)) return "app";
  if (/Mozilla/i.test(ua)) return "browser";
  return "other";
}

async function main() {
  const runsWhere = { url: { startsWith: RUNS_PREFIX } };

  // ── 1. By method + endpoint ──
  const byEndpoint = await prisma.requestLog.groupBy({
    by:      ["method", "endpoint"],
    where:   runsWhere,
    _count:  { _all: true },
    _min:    { createdAt: true },
    _max:    { createdAt: true },
  });
  const failedByEndpoint = await prisma.requestLog.groupBy({
    by:     ["method", "endpoint"],
    where:  { ...runsWhere, isFailed: true },
    _count: { _all: true },
  });
  const failedMap = new Map(failedByEndpoint.map((r) => [`${r.method} ${r.endpoint}`, r._count._all]));

  const total = byEndpoint.reduce((s, r) => s + r._count._all, 0);
  console.log(`\n=== 1. ${RUNS_PREFIX}* calls — ${total} total ===`);
  if (total === 0) {
    console.log("  None. computeEntryForUser has never been reached via the API in logged history.");
  }
  for (const r of byEndpoint) {
    const key = `${r.method} ${r.endpoint}`;
    console.log(
      `  ${key.padEnd(45)} count=${r._count._all}  failed=${failedMap.get(key) ?? 0}  ` +
      `first=${fmtLocal(r._min.createdAt)}  last=${fmtLocal(r._max.createdAt)}`
    );
  }

  if (total > 0) {
    // ── 2. Who called it ──
    const byCaller = await prisma.requestLog.groupBy({
      by:     ["companyId", "userRole", "isSystemAgent"],
      where:  runsWhere,
      _count: { _all: true },
      _max:   { createdAt: true },
    });
    const companyIds = [...new Set(byCaller.map((r) => r.companyId).filter(Boolean))];
    const companies = companyIds.length
      ? await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
      : [];
    const companyName = new Map(companies.map((c) => [c.id, c.name]));

    console.log("\n=== 2a. By company / role / B. Buddy ===");
    for (const r of byCaller) {
      console.log(
        `  ${(companyName.get(r.companyId) ?? r.companyId ?? "(no company)").padEnd(35)} ` +
        `[${r.companyId ?? "—"}]  role=${r.userRole ?? "—"}  bbuddy=${r.isSystemAgent}  ` +
        `count=${r._count._all}  last=${fmtLocal(r._max.createdAt)}`
      );
    }

    const byUa = await prisma.requestLog.groupBy({
      by:     ["userAgent"],
      where:  runsWhere,
      _count: { _all: true },
    });
    const kinds = {};
    for (const r of byUa) {
      const k = clientKind(r.userAgent);
      kinds[k] = (kinds[k] ?? 0) + r._count._all;
    }
    console.log("\n=== 2b. By client kind (from user agent) ===");
    for (const [k, n] of Object.entries(kinds)) console.log(`  ${k.padEnd(10)} ${n}`);
    console.log("  Distinct user agents:");
    for (const r of byUa) console.log(`    (${r._count._all}) ${r.userAgent ?? "—"}`);

    // ── 3. Most recent calls ──
    const recent = await prisma.requestLog.findMany({
      where:   runsWhere,
      orderBy: { createdAt: "desc" },
      take:    20,
      select:  { createdAt: true, method: true, url: true, statusCode: true, companyId: true, userRole: true },
    });
    console.log("\n=== 3. 20 most recent calls ===");
    for (const r of recent) {
      console.log(
        `  ${fmtLocal(r.createdAt)}  ${r.method.padEnd(6)} ${r.url}  status=${r.statusCode}  ` +
        `company=${companyName.get(r.companyId) ?? r.companyId ?? "—"}  role=${r.userRole ?? "—"}`
      );
    }
  }

  // ── 4. Context ──
  const otherPayroll = await prisma.requestLog.groupBy({
    by:     ["method", "endpoint"],
    where:  { url: { startsWith: PAYROLL_PREFIX }, NOT: { url: { startsWith: RUNS_PREFIX } } },
    _count: { _all: true },
    _max:   { createdAt: true },
  });
  console.log(`\n=== 4a. Other ${PAYROLL_PREFIX}* calls (excluding runs) ===`);
  if (otherPayroll.length === 0) console.log("  None.");
  for (const r of otherPayroll.sort((a, b) => b._count._all - a._count._all)) {
    console.log(
      `  ${`${r.method} ${r.endpoint}`.padEnd(45)} count=${r._count._all}  last=${fmtLocal(r._max.createdAt)}`
    );
  }

  const oldest = await prisma.requestLog.findFirst({
    orderBy: { createdAt: "asc" },
    select:  { createdAt: true },
  });
  const allCount = await prisma.requestLog.count();
  console.log("\n=== 4b. RequestLog coverage ===");
  console.log(`  Oldest row: ${fmtLocal(oldest?.createdAt)}   Total rows: ${allCount}`);
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
