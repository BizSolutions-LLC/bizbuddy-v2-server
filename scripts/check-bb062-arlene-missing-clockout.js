// scripts/check-bb062-arlene-missing-clockout.js
//
// BB-062 — Confirm: Arlene Backeng's Punch Logs show a 07/27/2026 record with
// a Time In but no Time Out ("Missing Out" / D-5 in the UI), still unresolved
// over a week later. This is READ-ONLY — it makes no writes.
//
// What it checks:
//   1. Resolves the User row for Arlene Backeng.
//   2. Lists every TimeLog she has ever had with status=true AND timeOut=null
//      (confirms the 07/27 record, and reveals whether this has happened
//      before — i.e. whether it's a recurring pattern, not a one-off).
//   3. Reads her current LiveUser row. The live auto-close cron
//      (src/jobs/autoClockOutJob.js, Pass 2) only closes a session by looking
//      up LiveUser.closeAt — and LiveUser.userId is UNIQUE, so only ONE open
//      session can ever be tracked per user at a time. Any open TimeLog whose
//      id does NOT match LiveUser.timeLogId is orphaned: no cron job will
//      ever find it again, and it will stay open until someone manually
//      enters a clock-out.
//   4. For context, looks up her UserShift/Shift for 07/27/2026 to show what
//      the scheduled shift end would have been that day.
//
// Usage: node scripts/check-bb062-arlene-missing-clockout.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const FIRST_NAME = "Arlene";
const LAST_NAME = "Backeng";
const FOCUS_DATE = "2026-07-27"; // the record shown in the screenshot

function fmt(d) {
  return d ? new Date(d).toISOString() : "—";
}

async function main() {
  // ── 1. Resolve the employee ────────────────────────────────────────────
  const users = await prisma.user.findMany({
    where: {
      profile: {
        firstName: { equals: FIRST_NAME, mode: "insensitive" },
        lastName: { equals: LAST_NAME, mode: "insensitive" },
      },
    },
    include: {
      profile: true,
      company: {
        select: {
          name: true,
          timeZone: true,
          defaultShiftHours: true,
          clockOutGracePeriod: true,
          autoClockOutWarningHours: true,
          autoClockOutGraceHours: true,
        },
      },
    },
  });

  if (users.length === 0) {
    console.log(`No user found matching "${FIRST_NAME} ${LAST_NAME}". Aborting.`);
    return;
  }
  if (users.length > 1) {
    console.log(
      `Multiple users match "${FIRST_NAME} ${LAST_NAME}" — disambiguate before proceeding:`
    );
    for (const u of users) {
      console.log(`  id=${u.id} email=${u.email} companyId=${u.companyId}`);
    }
    return;
  }

  const user = users[0];
  console.log("=== Employee ===");
  console.log(`  id: ${user.id}`);
  console.log(`  name: ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`  email: ${user.email}`);
  console.log(`  employeeId: ${user.employeeId || "—"}`);
  console.log(`  companyId: ${user.companyId}`);
  console.log(`  company: ${user.company?.name || "—"} (tz: ${user.company?.timeZone || "—"})`);
  console.log(
    `  company auto-clockout config: defaultShiftHours=${user.company?.defaultShiftHours ?? "—"} ` +
      `clockOutGracePeriod=${user.company?.clockOutGracePeriod ?? "—"}min ` +
      `warningHours=${user.company?.autoClockOutWarningHours ?? "—"} ` +
      `graceHours=${user.company?.autoClockOutGraceHours ?? "—"}`
  );

  // ── 2. Every open (status=true, timeOut=null) TimeLog in her history ────
  const openLogs = await prisma.timeLog.findMany({
    where: { userId: user.id, status: true, timeOut: null },
    orderBy: { timeIn: "asc" },
    select: {
      id: true,
      timeIn: true,
      timeOut: true,
      status: true,
      autoClockOut: true,
      autoClockOutAt: true,
      punchType: true,
      isApproved: true,
      deviceInfo: true,
      location: true,
      remarks: true,
      createdAt: true,
    },
  });

  console.log(`\n=== Open TimeLog records (status=true, timeOut=null): ${openLogs.length} ===`);
  if (openLogs.length === 0) {
    console.log("  None found — the missing clock-out record no longer exists as open.");
  }
  for (const log of openLogs) {
    const daysOpen = ((Date.now() - new Date(log.timeIn).getTime()) / 86_400_000).toFixed(1);
    console.log(`  --- TimeLog ${log.id} ---`);
    console.log(`    timeIn: ${fmt(log.timeIn)}  (${daysOpen} days ago)`);
    console.log(`    timeOut: ${fmt(log.timeOut)}`);
    console.log(`    punchType: ${log.punchType}`);
    console.log(`    isApproved: ${log.isApproved}`);
    console.log(`    autoClockOut: ${log.autoClockOut}  autoClockOutAt: ${fmt(log.autoClockOutAt)}`);
    console.log(`    deviceInfo: ${JSON.stringify(log.deviceInfo)}`);
    console.log(`    location: ${JSON.stringify(log.location)}`);
    console.log(`    remarks: ${JSON.stringify(log.remarks)}`);
  }

  // ── 3. Current LiveUser row — cross-check against the open logs above ───
  const liveUser = await prisma.liveUser.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      timeLogId: true,
      scheduledEnd: true,
      warnAt: true,
      closeAt: true,
      warningSent: true,
      createdAt: true,
    },
  });

  console.log("\n=== Current LiveUser row (drives the auto-close cron) ===");
  if (!liveUser) {
    console.log("  No LiveUser row exists for this employee at all.");
    console.log(
      "  => EVERY open TimeLog above is orphaned: the Pass 2 close job (autoClockOutJob.js)" +
        " only ever looks at LiveUser.closeAt, so none of them will ever be auto-closed."
    );
  } else {
    console.log(`  id: ${liveUser.id}`);
    console.log(`  tracks timeLogId: ${liveUser.timeLogId}`);
    console.log(`  scheduledEnd: ${fmt(liveUser.scheduledEnd)}`);
    console.log(`  warnAt: ${fmt(liveUser.warnAt)}  warningSent: ${liveUser.warningSent}`);
    console.log(`  closeAt: ${fmt(liveUser.closeAt)}`);
    console.log(`  createdAt: ${fmt(liveUser.createdAt)}`);

    const orphaned = openLogs.filter((l) => l.id !== liveUser.timeLogId);
    if (orphaned.length > 0) {
      console.log(
        `\n  => ORPHANED: ${orphaned.length} open TimeLog record(s) are NOT the one tracked by ` +
          `LiveUser (only one session per user can be tracked — LiveUser.userId is unique).`
      );
      console.log(
        "     These will never be picked up by autoClockOutJob.js Pass 2 and require a manual clock-out entry:"
      );
      for (const o of orphaned) {
        console.log(`       - TimeLog ${o.id} (timeIn ${fmt(o.timeIn)})`);
      }
    } else {
      console.log("\n  => All open TimeLog record(s) are currently tracked by LiveUser.");
    }
  }

  // ── 4. Scheduled shift context for the focus date (07/27/2026) ──────────
  const dayStart = new Date(`${FOCUS_DATE}T00:00:00.000Z`);
  const dayEnd = new Date(`${FOCUS_DATE}T23:59:59.999Z`);

  const userShift = await prisma.userShift.findFirst({
    where: {
      userId: user.id,
      assignedDate: { gte: dayStart, lte: dayEnd },
      status: { not: "cancelled" },
    },
    include: { shift: true },
  });

  console.log(`\n=== Scheduled shift for ${FOCUS_DATE} ===`);
  if (!userShift) {
    console.log("  No UserShift assignment found for this date (would have fallen back to defaultShiftHours).");
  } else {
    console.log(`  shiftName: ${userShift.shift?.shiftName}`);
    console.log(`  status: ${userShift.status}`);
    console.log(`  startTime (raw): ${fmt(userShift.shift?.startTime)}`);
    console.log(`  endTime (raw): ${fmt(userShift.shift?.endTime)}`);
    console.log(`  shift timeZone: ${userShift.shift?.timeZone || "(falls back to company tz)"}`);
  }

  console.log("\n=== Summary ===");
  console.log(
    `  Confirmed ${openLogs.length} open (status=true, timeOut=null) TimeLog record(s) for ` +
      `${FIRST_NAME} ${LAST_NAME}. See "ORPHANED" section above for which ones the auto-close ` +
      `cron can no longer reach — those require manual clock-out entry by a supervisor. ` +
      `No changes were made by this script.`
  );
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
