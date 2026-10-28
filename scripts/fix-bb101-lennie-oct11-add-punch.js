// scripts/fix-bb101-lennie-oct11-add-punch.js
//
// BB-101 — Add a missing punch for Lennie Capulong (Piedmont Adult Day
// Program, Staff Supervisor) on Sunday 2026-10-11, 08:00 AM → 05:00 PM
// America/Los_Angeles, REGULAR. Per user: 8–5, no lunch.
//
// State confirmed by scripts/check-bb101-lennie-oct11.js:
//   - no punch, punch request or leave on 10/11; no schedule (Sunday)
//   - cutoff cmuhqsh4e07czsj50nfvbfbdy (2026-09-30 → 2026-10-13, Staff
//     Supervisor) was reopened by the user and is OPEN
//
// Creates the TimeLog exactly the way an approved Request Punch Log does
// (createTimeLogFromRequest): completed, REGULAR, lunchBreak {} and
// autoLunchDeductionMinutes 0 — the span is taken at face value, so net = 9h.
// Then runs computeTimeLogSummary for the derived fields, and adds the
// pending TimeLogApproval in the cutoff (same shape as syncApprovalRecords).
//
// Note: all 10 of Lennie's approvals in this cutoff are "excluded", which
// matches BB-089 fixed hours. If she is on fixed hours, the next Cutoff page
// load auto-excludes this punch too — it shows for attendance but adds no pay.
//
// Guards: refuses if the cutoff isn't open, or if any of her punches overlaps
// the new span. Refuses to overwrite an existing backup.
//
// Usage:
//   node scripts/fix-bb101-lennie-oct11-add-punch.js           -> dry run (prints only)
//   node scripts/fix-bb101-lennie-oct11-add-punch.js --apply   -> writes for real
//   node scripts/fix-bb101-lennie-oct11-add-punch.js --revert  -> deletes what --apply created

require("module-alias/register");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const { computeTimeLogSummary } = require("@services/timeLogComputeService");

const prisma = new PrismaClient();

const COMPANY_ID       = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const USER_ID          = "cmnei2ajg0091nr4u2p5cc7rf"; // Lennie Capulong
const CUTOFF_PERIOD_ID = "cmuhqsh4e07czsj50nfvbfbdy"; // 2026-09-30 → 2026-10-13, Staff Supervisor
const TZ               = "America/Los_Angeles";
const TIME_IN          = moment.tz("2026-10-11 08:00", "YYYY-MM-DD HH:mm", TZ).toDate();
const TIME_OUT         = moment.tz("2026-10-11 17:00", "YYYY-MM-DD HH:mm", TZ).toDate();
const BACKUP_FILE      = path.join(__dirname, "backup-bb101-lennie-oct11-add-punch.json");

const DRY_RUN = !process.argv.includes("--apply") && !process.argv.includes("--revert");
const REVERT  = process.argv.includes("--revert");

const fmt = (d) => (d ? moment.tz(d, TZ).format("ddd YYYY-MM-DD hh:mm A z") : "—");

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup file found at ${BACKUP_FILE} — nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  const log = await prisma.timeLog.findUnique({ where: { id: backup.timeLogId }, select: { id: true, userId: true } });
  if (!log) {
    console.log(`TimeLog ${backup.timeLogId} no longer exists — nothing to revert.`);
    return;
  }
  if (log.userId !== USER_ID) throw new Error(`TimeLog ${log.id} is not Lennie's — refusing.`);

  const locked = await prisma.timeLogApproval.findFirst({
    where: { timeLogId: log.id, cutoffPeriod: { status: { in: ["locked", "processed"] } } },
  });
  if (locked) throw new Error("The punch is in a locked/processed cutoff — reopen it before reverting.");

  // TimeLogApproval cascades with the TimeLog.
  await prisma.timeLog.delete({ where: { id: log.id } });
  console.log(`Reverted: deleted TimeLog ${log.id} (and its approval rows).`);
  fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.reverted-${Date.now()}.json`));
}

async function main() {
  if (REVERT) return revert();

  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`Backup already exists: ${BACKUP_FILE}`);
    console.log("This punch was probably already added. Run --revert first if you want to redo it.");
    return;
  }

  const user = await prisma.user.findUnique({
    where:  { id: USER_ID },
    select: { companyId: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (!user || user.companyId !== COMPANY_ID) throw new Error("User not found in PadPro.");

  const cutoff = await prisma.cutoffPeriod.findUnique({ where: { id: CUTOFF_PERIOD_ID } });
  if (!cutoff) throw new Error(`Cutoff ${CUTOFF_PERIOD_ID} not found.`);
  if (cutoff.companyId !== COMPANY_ID || (cutoff.departmentId && cutoff.departmentId !== user.departmentId))
    throw new Error("Cutoff doesn't belong to Lennie's company/department.");
  if (cutoff.status !== "open") throw new Error(`Cutoff is ${cutoff.status} — reopen it first.`);

  const overlap = await prisma.timeLog.findFirst({
    where:  { userId: USER_ID, timeIn: { lt: TIME_OUT }, OR: [{ timeOut: null }, { timeOut: { gt: TIME_IN } }] },
    select: { id: true, timeIn: true, timeOut: true },
  });
  if (overlap) throw new Error(`Overlaps existing punch ${overlap.id} (${fmt(overlap.timeIn)} → ${fmt(overlap.timeOut)}) — refusing.`);

  console.log(`Employee: ${user.profile?.firstName} ${user.profile?.lastName} (${USER_ID})`);
  console.log(`New punch: REGULAR | ${fmt(TIME_IN)} → ${fmt(TIME_OUT)} | 9h, no lunch`);
  console.log(`UTC:       ${TIME_IN.toISOString()} → ${TIME_OUT.toISOString()}`);
  console.log(`Cutoff:    ${CUTOFF_PERIOD_ID} (${cutoff.status}) — pending approval row will be added`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to create it.");
    return;
  }

  const created = await prisma.timeLog.create({
    data: {
      userId:                    USER_ID,
      timeIn:                    TIME_IN,
      timeOut:                   TIME_OUT,
      status:                    false, // completed
      punchType:                 "REGULAR",
      coffeeBreaks:              [],
      lunchBreak:                {},
      autoLunchDeductionMinutes: 0,
    },
  });
  // Written straight away so --revert works even if a later step fails.
  fs.writeFileSync(BACKUP_FILE, JSON.stringify({
    ticket:         "BB-101",
    createdAt:      new Date().toISOString(),
    timeLogId:      created.id,
    cutoffPeriodId: CUTOFF_PERIOD_ID,
    timeIn:         TIME_IN.toISOString(),
    timeOut:        TIME_OUT.toISOString(),
  }, null, 2));

  const derived = await computeTimeLogSummary(created.id);

  await prisma.timeLogApproval.createMany({
    data: [{ id: randomUUID(), timeLogId: created.id, cutoffPeriodId: CUTOFF_PERIOD_ID, status: "pending", segmentType: null }],
    skipDuplicates: true,
  });

  console.log(`\nCreated TimeLog ${created.id}`);
  console.log(`  net ${derived?.netWorkedHours ?? "—"}h | gross ${derived?.grossHours ?? "—"}h | lunch ${derived?.lunchDeductionMinutes ?? "—"}min | rawOt ${derived?.rawOtMinutes ?? "—"}min`);
  console.log(`  pending approval added in cutoff ${CUTOFF_PERIOD_ID}`);
  console.log(`Backup written: ${BACKUP_FILE}`);
}

main()
  .catch((err) => {
    console.error("Failed:", err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
