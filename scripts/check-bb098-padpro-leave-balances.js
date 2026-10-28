// scripts/check-bb098-padpro-leave-balances.js
//
// BB-098 — READ-ONLY expiration PREVIEW of the current leave balances
// (LeaveBalance.balanceHours, the "available" value in the app) for every
// employee in Piedmont Adult Day Program ("PadPro"). Documents how a
// fiscal-year expiration rule WOULD split and expire today's balances,
// before anything is built into the system.
//
// SELECTs only against the DB. The only write is the CSV file on local disk.
// Credentials are never printed (host + db name only).
//
// Rule being previewed (all three are placeholders until the company decides):
//   - ANNUAL_HOURS per fiscal year (40h). A balance above that is assumed to
//     have been carried over from earlier fiscal years, in 40h chunks:
//     first 40h = current FY, next 40h = previous FY, and so on.
//     (Assumes usage always consumed the oldest credits first, so what's left
//     is the newest credits.)
//   - FY_START_MONTH: month the fiscal year starts (1 = January).
//   - LIFETIME_FISCAL_YEARS: credits are usable during the FY they were
//     granted plus the following (N - 1) fiscal years, then expire at the end
//     of that FY. With N = 2, FY2026 credits expire at the end of FY2027.
//     Chunks older than that are shown as "past expiration" — they would be
//     removed the day the rule goes live.
//   The 40h chunking is applied to each leave type separately.
//
// CSV output: rule summary at the top, then one row per employee per leave
// type with a non-zero balance (active employees first, then inactive/deleted
// still holding a balance; active employees with no balance get one "(none)"
// row). Last row = totals across active employees.
//
// Output file: scripts/bb098-padpro-leave-expiration-preview-YYYY-MM-DD.csv
//
// Usage: node scripts/check-bb098-padpro-leave-balances.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID            = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const ANNUAL_HOURS          = 40; // leave credits granted per fiscal year
const FY_START_MONTH        = 1;  // PLACEHOLDER — company to decide (1 = January)
const LIFETIME_FISCAL_YEARS = 2;  // PLACEHOLDER — company to decide

function describeDbTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL not set in this process";
  try {
    const u = new URL(url);
    return `host=${u.hostname} port=${u.port || "(default)"} database=${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "DATABASE_URL present but could not be parsed";
  }
}

const num = (v) => (v == null ? 0 : parseFloat(v.toString()));
const r2 = (n) => +n.toFixed(2);
const fullName = (u) =>
  [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(" ") || u.username;
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Fiscal year is identified by the calendar year it starts in.
const fyLabel = (startYear) =>
  FY_START_MONTH === 1 ? `FY${startYear}` : `FY${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
const fyEndDate = (startYear, tz) =>
  moment.tz({ year: startYear + 1, month: FY_START_MONTH - 1, day: 1 }, tz)
    .subtract(1, "day")
    .format("YYYY-MM-DD");

// Newest-first split of a balance into fiscal-year chunks.
// buckets[i] = hours attributed to (current FY - i), for i < LIFETIME_FISCAL_YEARS.
// pastExpired = anything older than the lifetime.
function splitBalance(balance) {
  if (balance <= 0) {
    // Nothing to expire; keep a zero/negative balance on the current FY.
    return { buckets: [balance, ...Array(LIFETIME_FISCAL_YEARS - 1).fill(0)], pastExpired: 0 };
  }
  let left = balance;
  const buckets = [];
  for (let i = 0; i < LIFETIME_FISCAL_YEARS; i++) {
    const take = Math.min(ANNUAL_HOURS, left);
    buckets.push(take);
    left -= take;
  }
  return { buckets, pastExpired: left };
}

async function main() {
  console.log("=== BB-098 PadPro leave expiration PREVIEW (read-only) ===");
  console.log(`DB target: ${describeDbTarget()}`);

  const company = await prisma.company.findUnique({
    where: { id: COMPANY_ID },
    select: { name: true, timeZone: true },
  });
  if (!company) {
    console.log(`Company ${COMPANY_ID} not found. Aborting.`);
    return;
  }
  const tz = company.timeZone || "America/Los_Angeles";
  const today = moment.tz(tz);
  const currentFyStart = today.month() + 1 >= FY_START_MONTH ? today.year() : today.year() - 1;
  console.log(`Company: ${company.name} (${COMPANY_ID}) | tz=${tz} | today=${today.format("YYYY-MM-DD")}`);
  console.log(`Current fiscal year: ${fyLabel(currentFyStart)}`);

  // Per bucket i: which FY it represents and when it expires.
  const bucketInfo = Array.from({ length: LIFETIME_FISCAL_YEARS }, (_, i) => {
    const grantFy = currentFyStart - i;
    return {
      label: fyLabel(grantFy),
      expiresOn: fyEndDate(grantFy + LIFETIME_FISCAL_YEARS - 1, tz),
    };
  });

  const [policies, users, balances] = await Promise.all([
    prisma.leavePolicy.findMany({
      where: { companyId: COMPANY_ID },
      select: { id: true, leaveType: true, isArchived: true },
      orderBy: { leaveType: "asc" },
    }),
    prisma.user.findMany({
      where: { companyId: COMPANY_ID },
      select: {
        id: true,
        username: true,
        status: true,
        profile: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.leaveBalance.findMany({
      where: { policy: { companyId: COMPANY_ID } },
      select: { userId: true, policyId: true, balanceHours: true },
    }),
  ]);

  // userId -> policyId -> hours
  const byUser = {};
  for (const b of balances) {
    (byUser[b.userId] ??= {})[b.policyId] = num(b.balanceHours);
  }

  const sortedUsers = [...users].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const activeUsers = sortedUsers.filter((u) => u.status === "active");
  const otherUsers = sortedUsers.filter((u) => u.status !== "active");

  const header = [
    "Employee",
    "Employee ID",
    "Status",
    "Leave Type",
    "Current Balance (h)",
    ...bucketInfo.flatMap((b, i) => [
      `${b.label}${i === 0 ? " (current FY)" : ""} credits (h)`,
      `${b.label} expires on`,
    ]),
    `Older than ${LIFETIME_FISCAL_YEARS} FYs - past expiration (h)`,
    "Balance after expiration (h)",
    "Next expiration date",
    "Hours expiring next",
  ];

  const totals = { balance: 0, buckets: Array(LIFETIME_FISCAL_YEARS).fill(0), pastExpired: 0, after: 0 };

  const buildRow = (user, policy, balance, isActive) => {
    const { buckets, pastExpired } = splitBalance(balance);
    const after = balance - pastExpired;

    // Oldest still-valid chunk with hours is the next to expire.
    let nextDate = "";
    let nextHours = "";
    for (let i = LIFETIME_FISCAL_YEARS - 1; i >= 0; i--) {
      if (buckets[i] > 0) {
        nextDate = bucketInfo[i].expiresOn;
        nextHours = r2(buckets[i]);
        break;
      }
    }

    if (isActive) {
      totals.balance += balance;
      buckets.forEach((h, i) => (totals.buckets[i] += h));
      totals.pastExpired += pastExpired;
      totals.after += after;
    }

    return [
      fullName(user),
      user.id,
      user.status,
      policy ? `${policy.leaveType}${policy.isArchived ? " (archived)" : ""}` : "(none)",
      r2(balance),
      ...buckets.flatMap((h, i) => [r2(h), h > 0 ? bucketInfo[i].expiresOn : ""]),
      r2(pastExpired),
      r2(after),
      nextDate,
      nextHours,
    ];
  };

  const dataRows = [];
  let employeesWithPastExpired = 0;
  for (const [list, isActive] of [[activeUsers, true], [otherUsers, false]]) {
    for (const u of list) {
      const held = policies.filter((p) => (byUser[u.id]?.[p.id] ?? 0) !== 0);
      if (held.length === 0) {
        if (isActive) dataRows.push(buildRow(u, null, 0, true));
        continue;
      }
      let hasPast = false;
      for (const p of held) {
        const bal = byUser[u.id][p.id];
        const row = buildRow(u, p, bal, isActive);
        if (splitBalance(bal).pastExpired > 0) hasPast = true;
        dataRows.push(row);
      }
      if (isActive && hasPast) employeesWithPastExpired++;
    }
  }

  const totalRow = [
    `TOTAL (${activeUsers.length} active employees)`,
    "",
    "",
    "",
    r2(totals.balance),
    ...totals.buckets.flatMap((h) => [r2(h), ""]),
    r2(totals.pastExpired),
    r2(totals.after),
    "",
    "",
  ];

  const ruleLines = [
    ["BB-098 Leave Expiration Preview", `${company.name}`],
    ["Generated", today.format("YYYY-MM-DD HH:mm z")],
    ["Rule", `${ANNUAL_HOURS}h leave credits per fiscal year; a balance above ${ANNUAL_HOURS}h is treated as carried over from earlier fiscal years in ${ANNUAL_HOURS}h chunks (newest first)`],
    ["Fiscal year start", `Month ${FY_START_MONTH} (PLACEHOLDER - company to decide)`],
    ["Credit lifetime", `${LIFETIME_FISCAL_YEARS} fiscal years incl. the year granted, expiring at that FY's end (PLACEHOLDER - company to decide)`],
    ["Current fiscal year", fyLabel(currentFyStart)],
    ["Past expiration", "Hours older than the lifetime would be removed on the day the rule goes live"],
    ["Note", "Chunk years are an assumption from the balance size, not from actual grant dates"],
    [],
  ];

  const lines = [...ruleLines, header, ...dataRows, totalRow];
  const csv = lines.map((l) => l.map(csvCell).join(",")).join("\n") + "\n";

  const outFile = path.join(__dirname, `bb098-padpro-leave-expiration-preview-${today.format("YYYY-MM-DD")}.csv`);
  fs.writeFileSync(outFile, csv);

  console.log(`Active employees: ${activeUsers.length}`);
  console.log(`Active employees with hours past expiration: ${employeesWithPastExpired}`);
  console.log(`Total current balance (active): ${r2(totals.balance)}h`);
  bucketInfo.forEach((b, i) =>
    console.log(`  ${b.label} credits: ${r2(totals.buckets[i])}h (expire ${b.expiresOn})`)
  );
  console.log(`  Past expiration: ${r2(totals.pastExpired)}h`);
  console.log(`  Balance after expiration: ${r2(totals.after)}h`);
  console.log(`CSV written: ${outFile}`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
