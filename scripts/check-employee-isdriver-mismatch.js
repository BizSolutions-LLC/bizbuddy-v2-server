// scripts/check-employee-isdriver-mismatch.js
//
// Investigating a discrepancy: Jovencio Jerico Espejo (jespejo@lsahomes.org)
// shows a green "driver" car icon on the cutoff-approvals screen, but his
// Edit Employee modal shows the "Driver Schedule" toggle already saved OFF,
// and his actual punch history (Aug 5-7) is plain Regular punches with no
// Driver segments at all.
//
// Code trace already done: EmploymentDetail.isDriver (schema.prisma:531) is
// the only persisted "driver" flag anywhere in this codebase — read/write
// only via employeeController.js. Nothing in timeLogComputeService.js,
// daycareCutoffStrategy.js, or punchTypeUtils.js (resolvePunchType) actually
// reads it — those all derive isDriverAm/isDriverPm purely from
// TimeLog.punchType. EmploymentDetail.userId is @unique, so a duplicate row
// isn't possible. This script is a direct, definitive read to confirm the
// DB value and cross-check it against his actual recent punch types.
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-employee-isdriver-mismatch.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: "jespejo@lsahomes.org", mode: "insensitive" } },
    select: {
      id: true,
      email: true,
      companyId: true,
      profile: { select: { firstName: true, lastName: true } },
      employmentDetail: {
        select: {
          id: true, isDriver: true, jobTitle: true, departmentId: true,
          createdAt: true, updatedAt: true,
          department: { select: { name: true } },
        },
      },
    },
  });

  if (!user) {
    console.log("No user found with email jespejo@lsahomes.org. Aborting.");
    return;
  }

  const name = user.profile ? `${user.profile.firstName} ${user.profile.lastName}` : user.email;
  console.log(`=== ${name} (${user.id}) ===`);
  console.log(`    email: ${user.email}  companyId: ${user.companyId}`);

  if (!user.employmentDetail) {
    console.log("    No EmploymentDetail row exists for this user at all.");
  } else {
    const ed = user.employmentDetail;
    console.log(`\n=== EmploymentDetail ${ed.id} ===`);
    console.log(`    isDriver: ${ed.isDriver}`);
    console.log(`    jobTitle: ${ed.jobTitle || "—"}  department: ${ed.department?.name || "—"}`);
    console.log(`    createdAt: ${fmt(ed.createdAt)}  updatedAt: ${fmt(ed.updatedAt)}`);
    console.log(
      ed.isDriver
        ? "    -> DB says isDriver = TRUE. This would mean the Edit Employee modal is showing stale/wrong data — the opposite direction from what was reported. Worth re-checking the modal against this."
        : "    -> DB says isDriver = FALSE, matching what the Edit Employee modal showed. If the cutoff-approval screen's icon still shows him as a driver, that icon is being sourced from something other than this field (or a stale client-side cache) — not from current server data."
    );
  }

  // ── Recent punch-type history, for cross-check ──
  const recentLogs = await prisma.timeLog.findMany({
    where: { userId: user.id },
    select: { id: true, timeIn: true, timeOut: true, punchType: true },
    orderBy: { timeIn: "desc" },
    take: 15,
  });

  console.log(`\n=== Most recent ${recentLogs.length} TimeLog(s) ===`);
  for (const log of recentLogs) {
    console.log(`    ${fmt(log.timeIn)} -> ${fmt(log.timeOut)}  punchType=${log.punchType}`);
  }
  const everHadDriverPunch = recentLogs.some((l) => l.punchType !== "REGULAR" && l.punchType !== "TRAINING");
  console.log(
    everHadDriverPunch
      ? "\n    -> At least one Driver/Aide-family punch found in recent history."
      : "\n    -> No Driver/Aide-family punches in recent history — consistent with isDriver being false."
  );

  console.log("\nNo changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
