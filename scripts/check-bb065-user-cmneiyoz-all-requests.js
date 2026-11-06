// scripts/check-bb065-user-cmneiyoz-all-requests.js
//
// BB-065 — Broader searches by date/clock-time both came back empty, so instead
// of guessing further, this checks EVERYTHING tied to user id
// cmneiyoz600chnr4ulk3x670g (resolved earlier as "Jane Horowitz") directly —
// as an employee (userId), as an approver (approverId), any status, any date.
// This will settle whether she's actually the employee on the target request
// (not just the approver, as previously assumed), and show her full request
// history either way.
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb065-user-cmneiyoz-all-requests.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const TARGET_ID = "cmneiyoz600chnr4ulk3x670g";

function fmtUtc(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtLocal(d, tz) {
  if (!d) return "—";
  return moment(d).tz(tz || "UTC").format("YYYY-MM-DD (ddd) hh:mm A z");
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { id: TARGET_ID },
    select: {
      id: true,
      email: true,
      role: true,
      companyId: true,
      departmentId: true,
      profile: { select: { firstName: true, lastName: true } },
      company: { select: { name: true, timeZone: true } },
    },
  });

  if (!user) {
    console.log(`No User found for id ${TARGET_ID}.`);
    return;
  }

  console.log("=== User ===");
  console.log(`  id: ${user.id}`);
  console.log(`  name: ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`  email: ${user.email}  role: ${user.role}`);
  console.log(`  company: ${user.company?.name || "—"} (tz=${user.company?.timeZone || "—"})`);

  const tz = user.company?.timeZone || "UTC";

  // ── As employee (userId) ─────────────────────────────────────────────────
  const asEmployee = await prisma.requestedTimeLog.findMany({
    where: { userId: TARGET_ID },
    orderBy: { requestedDate: "desc" },
  });

  console.log(`\n=== As EMPLOYEE (userId=${TARGET_ID}): ${asEmployee.length} request(s) ===`);
  for (const r of asEmployee) {
    console.log(`  --- ${r.id} ---`);
    console.log(`    status: ${r.status}  reason: "${r.reason || "—"}"`);
    console.log(`    requestedDate: local=${fmtLocal(r.requestedDate, tz)}  UTC=${fmtUtc(r.requestedDate)}`);
    console.log(`    requestedClockIn: local=${fmtLocal(r.requestedClockIn, tz)}  UTC=${fmtUtc(r.requestedClockIn)}`);
    console.log(`    requestedClockOut: local=${fmtLocal(r.requestedClockOut, tz)}  UTC=${fmtUtc(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration} min  estimatedNetHours: ${r.estimatedNetHours}`);
    console.log(`    submittedAt: ${fmtUtc(r.submittedAt)}  approvedAt: ${fmtUtc(r.approvedAt)}`);
    console.log(`    approverId: ${r.approverId || "—"}`);
  }

  // ── As approver (approverId) ─────────────────────────────────────────────
  const asApprover = await prisma.requestedTimeLog.findMany({
    where: { approverId: TARGET_ID },
    orderBy: { requestedDate: "desc" },
    include: {
      user: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } },
    },
  });

  console.log(`\n=== As APPROVER (approverId=${TARGET_ID}): ${asApprover.length} request(s) ===`);
  for (const r of asApprover) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    console.log(`  --- ${r.id} ---`);
    console.log(`    employee: ${name}`);
    console.log(`    status: ${r.status}  reason: "${r.reason || "—"}"`);
    console.log(`    requestedDate: local=${fmtLocal(r.requestedDate, tz)}  UTC=${fmtUtc(r.requestedDate)}`);
    console.log(`    requestedClockIn: local=${fmtLocal(r.requestedClockIn, tz)}  UTC=${fmtUtc(r.requestedClockIn)}`);
    console.log(`    requestedClockOut: local=${fmtLocal(r.requestedClockOut, tz)}  UTC=${fmtUtc(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration} min  estimatedNetHours: ${r.estimatedNetHours}`);
  }

  console.log("\nNo changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
