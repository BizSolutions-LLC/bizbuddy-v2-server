// scripts/fix-bb125-robert-sep04-segments.js
//
// BB-125 audit correction — Robert Ramirez (Piedmont Adult Day Program), Sep 4 2026.
// Driver/Aide punch 6:38 AM → 1:30 PM (auto clock-out). The old punch-wins code
// (before v2.11.10) treated it as a REGULAR punch: rewrote the TimeLog to
// 8:00 → 1:30 and stamped that one window on all 3 segments, so reports added
// the same 5.5h more than once → 11h paid.
//
// Decision (user, 2026-11-14): he didn't complete the day, so the correct pay is
//   Driver AM 1.25h (6:45 → 8:00) + Regular 5.5h (8:00 → 1:30), no Driver PM.
//
// What --apply writes (one transaction):
//   - TimeLogApproval driver_am: approved, approvedClockIn/Out = its segment window,
//     scheduledHours = actualHours = 1.25
//   - TimeLogApproval regular: approved, approvedClockIn/Out = its segment window,
//     scheduledHours = actualHours = 5.5
//   - TimeLogApproval driver_pm: excluded, approved times / hours cleared
//   - all three notes: "BB-125 audit correction: …"
//   - TimeLog: timeIn back to the raw 6:38 (originalTimeIn); timeOut stays 1:30;
//     driverAm/regular/driverPm segment hours 1.25 / 5.5 / 0, netWorkedHours 6.75,
//     rawOtMinutes 0 (same values the segment sync-back writes)
// Not touched: his unpaid Sick Leave for 9-04, overtime, the cutoff row.
//
// Safety checks before --apply:
//   - the expected TimeLog, Robert Ramirez, Driver/Aide, raw clock-in 6:38
//   - exactly 3 approvals (driver_am / regular / driver_pm) in a cutoff that is not
//     locked or processed
//   - segment windows: driver_am 6:45 → 8:00 and regular 8:00 → 1:30 (company zone)
//   - the backup file doesn't exist yet
//
// Backup: scripts/backup-bb125-robert-sep04.json (TimeLog + approvals before), used by --revert.
//
// Usage:
//   node scripts/fix-bb125-robert-sep04-segments.js            # dry run
//   node scripts/fix-bb125-robert-sep04-segments.js --apply
//   node scripts/fix-bb125-robert-sep04-segments.js --revert

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

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const TIMELOG_ID = "cmtn01gsx0eykse508iij9ltj";
const AM_HOURS = 1.25;
const REG_HOURS = 5.5;
const BACKUP_FILE = path.join(__dirname, "backup-bb125-robert-sep04.json");
const TX_OPTIONS = { maxWait: 15000, timeout: 120000 };
const NOTE = "BB-125 audit correction: day not completed — Driver AM 1.25h + Regular 5.5h, no Driver PM";

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const hm = (d, tz) => (d ? moment.tz(d, tz).format("HH:mm") : "—");

async function loadState() {
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID }, select: { name: true, timeZone: true } });
  const tz = company?.timeZone || "America/Los_Angeles";
  const timeLog = await prisma.timeLog.findUnique({
    where: { id: TIMELOG_ID },
    include: { user: { select: { id: true, email: true, companyId: true, profile: { select: { firstName: true, lastName: true } } } } },
  });
  const approvals = timeLog
    ? await prisma.timeLogApproval.findMany({
        where:   { timeLogId: TIMELOG_ID },
        include: { cutoffPeriod: { select: { id: true, status: true } } },
      })
    : [];
  return { tz, timeLog, approvals };
}

function printState({ tz, timeLog: t, approvals }) {
  if (!t) return console.log(`TimeLog ${TIMELOG_ID} not found`);
  const name = [t.user.profile?.firstName, t.user.profile?.lastName].filter(Boolean).join(" ");
  console.log(`Employee: ${name} <${t.user.email}>`);
  console.log(`TimeLog ${t.id} ${t.punchType}  current ${hm(t.timeIn, tz)} → ${hm(t.timeOut, tz)}  raw ${hm(t.originalTimeIn, tz)} → ${hm(t.originalTimeOut, tz)}  autoClockOut=${t.autoClockOut}`);
  console.log(`  hours: AM=${t.driverAmSegmentHours} REG=${t.regularSegmentHours} PM=${t.driverPmSegmentHours} net=${t.netWorkedHours}  lunch=${JSON.stringify(t.lunchBreak)}`);
  for (const a of approvals) {
    console.log(`  ${a.segmentType} ${a.status}  window ${hm(a.segmentStart, tz)} → ${hm(a.segmentEnd, tz)}  approved ${hm(a.approvedClockIn, tz)} → ${hm(a.approvedClockOut, tz)}  sched=${a.scheduledHours} actual=${a.actualHours}  cutoff=${a.cutoffPeriod?.status}`);
  }
  console.log("");
}

function checkSafety({ tz, timeLog: t, approvals }) {
  const problems = [];
  if (!t) return [`TimeLog ${TIMELOG_ID} not found`];
  const name = [t.user.profile?.firstName, t.user.profile?.lastName].filter(Boolean).join(" ");
  if (t.user.companyId !== COMPANY_ID) problems.push("employee is not in PadPro");
  if (!/robert/i.test(name) || !/ramirez/i.test(name)) problems.push(`employee is "${name}", expected Robert Ramirez`);
  if (t.punchType !== "DRIVER_AIDE") problems.push(`punch type is ${t.punchType}, expected DRIVER_AIDE`);
  if (hm(t.originalTimeIn, tz) !== "06:38") problems.push(`raw clock-in is ${hm(t.originalTimeIn, tz)}, expected 06:38`);
  const seg = Object.fromEntries(approvals.map((a) => [a.segmentType, a]));
  if (approvals.length !== 3 || !seg.driver_am || !seg.regular || !seg.driver_pm) problems.push("expected exactly 3 approvals: driver_am, regular, driver_pm");
  if (approvals.some((a) => ["locked", "processed"].includes(a.cutoffPeriod?.status))) problems.push("the cutoff is locked or processed — reopen it first");
  if (seg.driver_am && `${hm(seg.driver_am.segmentStart, tz)}-${hm(seg.driver_am.segmentEnd, tz)}` !== "06:45-08:00") problems.push(`driver_am window is ${hm(seg.driver_am.segmentStart, tz)}-${hm(seg.driver_am.segmentEnd, tz)}, expected 06:45-08:00`);
  if (seg.regular && `${hm(seg.regular.segmentStart, tz)}-${hm(seg.regular.segmentEnd, tz)}` !== "08:00-13:30") problems.push(`regular window is ${hm(seg.regular.segmentStart, tz)}-${hm(seg.regular.segmentEnd, tz)}, expected 08:00-13:30`);
  if (fs.existsSync(BACKUP_FILE)) problems.push(`backup already exists at ${BACKUP_FILE} — already applied?`);
  return problems;
}

async function apply({ timeLog: t, approvals }) {
  const seg = Object.fromEntries(approvals.map((a) => [a.segmentType, a]));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.timeLogApproval.update({
      where: { id: seg.driver_am.id },
      data: { status: "approved", approvedAt: now, approvedClockIn: seg.driver_am.segmentStart, approvedClockOut: seg.driver_am.segmentEnd,
              scheduledHours: AM_HOURS, actualHours: AM_HOURS, notes: NOTE },
    });
    await tx.timeLogApproval.update({
      where: { id: seg.regular.id },
      data: { status: "approved", approvedAt: now, approvedClockIn: seg.regular.segmentStart, approvedClockOut: seg.regular.segmentEnd,
              scheduledHours: REG_HOURS, actualHours: REG_HOURS, notes: NOTE },
    });
    await tx.timeLogApproval.update({
      where: { id: seg.driver_pm.id },
      data: { status: "excluded", approvedAt: now, approvedClockIn: null, approvedClockOut: null,
              scheduledHours: null, actualHours: null, notes: NOTE },
    });
    await tx.timeLog.update({
      where: { id: t.id },
      data: {
        timeIn: t.originalTimeIn ?? t.timeIn,
        driverAmSegmentHours: AM_HOURS, regularSegmentHours: REG_HOURS, driverPmSegmentHours: 0,
        netWorkedHours: AM_HOURS + REG_HOURS, rawOtMinutes: 0,
      },
    });
  }, TX_OPTIONS);

  // Backup written after the commit, holding the BEFORE state (for --revert).
  fs.writeFileSync(BACKUP_FILE, JSON.stringify({
    ticket: "BB-125", appliedAt: now.toISOString(),
    timeLog: {
      id: t.id, timeIn: t.timeIn, driverAmSegmentHours: t.driverAmSegmentHours, regularSegmentHours: t.regularSegmentHours,
      driverPmSegmentHours: t.driverPmSegmentHours, netWorkedHours: t.netWorkedHours, rawOtMinutes: t.rawOtMinutes,
    },
    approvals: approvals.map((a) => ({
      id: a.id, status: a.status, approvedAt: a.approvedAt, approvedClockIn: a.approvedClockIn, approvedClockOut: a.approvedClockOut,
      scheduledHours: a.scheduledHours, actualHours: a.actualHours, notes: a.notes,
    })),
  }, null, 2));
  console.log(`✅ Applied: Driver AM ${AM_HOURS}h + Regular ${REG_HOURS}h = ${AM_HOURS + REG_HOURS}h, Driver PM excluded. Backup: ${BACKUP_FILE}`);
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) return console.log(`No backup at ${BACKUP_FILE} — nothing to revert.`);
  const b = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  await prisma.$transaction(async (tx) => {
    for (const a of b.approvals) {
      await tx.timeLogApproval.update({
        where: { id: a.id },
        data: {
          status: a.status, approvedAt: a.approvedAt ? new Date(a.approvedAt) : null,
          approvedClockIn: a.approvedClockIn ? new Date(a.approvedClockIn) : null,
          approvedClockOut: a.approvedClockOut ? new Date(a.approvedClockOut) : null,
          scheduledHours: a.scheduledHours, actualHours: a.actualHours, notes: a.notes,
        },
      });
    }
    const t = b.timeLog;
    await tx.timeLog.update({
      where: { id: t.id },
      data: {
        timeIn: new Date(t.timeIn), driverAmSegmentHours: t.driverAmSegmentHours, regularSegmentHours: t.regularSegmentHours,
        driverPmSegmentHours: t.driverPmSegmentHours, netWorkedHours: t.netWorkedHours, rawOtMinutes: t.rawOtMinutes,
      },
    });
  }, TX_OPTIONS);
  fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.reverted-${Date.now()}.json`));
  console.log("↩️  Restored the TimeLog and its 3 approvals from the backup.");
}

async function main() {
  if (REVERT) return revert();
  const state = await loadState();
  printState(state);
  const problems = checkSafety(state);
  if (problems.length) {
    console.log("⛔ Safety checks failed — nothing written:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("Plan:");
  console.log(`  driver_am → approved ${AM_HOURS}h (06:45 → 08:00)`);
  console.log(`  regular   → approved ${REG_HOURS}h (08:00 → 13:30)`);
  console.log("  driver_pm → excluded");
  console.log(`  TimeLog   → clock-in back to raw 06:38, net ${AM_HOURS + REG_HOURS}h (was paid as 11h)\n`);
  if (!APPLY) return console.log("Dry run — re-run with --apply to write.");
  await apply(state);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
