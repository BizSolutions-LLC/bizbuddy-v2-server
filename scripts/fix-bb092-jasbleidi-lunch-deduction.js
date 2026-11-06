// scripts/fix-bb092-jasbleidi-lunch-deduction.js
//
// BB-092 — Driver/Aide punches never subtracted the punched lunch. The code fix
// (timeLogComputeService + daycareCutoffStrategy) handles new punches; this
// script corrects Jasbleidi Mendoza's existing punches (Piedmont Adult Day
// Program) to match, using the same rule: lunch is subtracted from whichever
// segment window it falls in. Numbers match
// check-bb092-jasbleidi-lunch-recalc-preview.js.
//
// STAGED (per staged-backfill rule):
//   default  → STAGE 1 only: 2026-09-30 (cmuo6f00q06gprp4zpfzus5hn)
//   --all    → STAGE 1 + STAGE 2 (her other 7 days, NOT 09/25)
//
// 2026-09-25 (cmuh1d8ix039jsj50p3a6zzpr) is deliberately EXCLUDED — its lunch
// punch (08:32 AM → 02:21 PM, 348.7 min) was never ended. It is left for an
// admin edit of the lunch. The script refuses to touch it even if listed.
//
// Per punch, per segment (only segments the lunch actually overlaps):
//   pending  → TimeLog.<seg>SegmentHours −= lunch inside the segment window
//              (window = segmentStart/End clamped to timeIn/timeOut)
//   approved → TimeLogApproval.actualHours/scheduledHours −= lunch inside
//              [approvedClockIn, approvedClockOut], and the TimeLog segment
//              field is set to the new value (same as the sync-back)
//   excluded → untouched
// Then TimeLog.netWorkedHours = new segment sum, lunchDeductionMinutes =
// minutes actually deducted.
//
// Safety:
//   - Each segment is checked first: if its hours already equal (window − lunch)
//     it is skipped as already corrected (e.g. Sync ran after the code fix
//     deployed). If they match neither the un-deducted nor the deducted value,
//     the whole punch is SKIPPED and reported — no guessing.
//   - Punches in a locked/processed cutoff are skipped.
//   - Backup JSON is written before any write; an existing backup file is never
//     overwritten (so --revert always restores the true original).
//   - One transaction per punch.
//
// Usage:
//   node scripts/fix-bb092-jasbleidi-lunch-deduction.js                 -> dry run, stage 1
//   node scripts/fix-bb092-jasbleidi-lunch-deduction.js --apply         -> write, stage 1
//   node scripts/fix-bb092-jasbleidi-lunch-deduction.js --all           -> dry run, stage 1 + 2
//   node scripts/fix-bb092-jasbleidi-lunch-deduction.js --all --apply   -> write, stage 1 + 2
//   node scripts/fix-bb092-jasbleidi-lunch-deduction.js --revert [--all]-> restore from that stage's backup

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const USER_ID    = "cmnej60ca00emnr4uz0ycfkb7"; // Jasbleidi Mendoza

const STAGE_1 = [
  "cmuo6f00q06gprp4zpfzus5hn", // 2026-09-30  pending   Regular 5.50 → 5.03
];
const STAGE_2 = [
  "cmubbodsl0leaqy50isc50u50", // 2026-09-21  APPROVED  Regular 5.50 → 4.99
  "cmucr4bej0xamqy50q8pzm2f4", // 2026-09-22  pending   Regular 5.50 → 5.07
  "cmue69utf1ahbqy50shps4ddr", // 2026-09-23  pending   Regular 5.50 → 4.90
  "cmufm14nw1o4nqy50ltqd2f3v", // 2026-09-24  pending   Regular 5.18 → 4.48
  "cmulbphq60e6nsj50i8fyco5s", // 2026-09-28  pending   Regular 5.50 → 5.20
  "cmuplhb180fk4rp4z66m4t8r6", // 2026-10-01  pending   Regular 5.50 → 4.87
  "cmur1o6qk05gzp04uhdh0c6kj", // 2026-10-02  pending   Regular 5.50 → 5.06
];
const EXCLUDED = new Set([
  "cmuh1d8ix039jsj50p3a6zzpr", // 2026-09-25  unended lunch (348.7 min) — admin edit instead
]);

const ALL     = process.argv.includes("--all");
const APPLY   = process.argv.includes("--apply");
const REVERT  = process.argv.includes("--revert");
const DRY_RUN = !APPLY && !REVERT;

const TARGET_IDS  = ALL ? [...STAGE_1, ...STAGE_2] : STAGE_1;
const BACKUP_FILE = path.join(__dirname, `backup-bb092-jasbleidi-lunch-${ALL ? "all" : "stage1"}.json`);

const TOLERANCE = 0.011;
const SEGMENT_FIELD = {
  driver_am: "driverAmSegmentHours",
  regular:   "regularSegmentHours",
  driver_pm: "driverPmSegmentHours",
};

const num = (v) => (v == null ? null : parseFloat(v.toString()));
const r2  = (n) => +n.toFixed(2);
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;

// Same rule as lunchOverlapMs in src/services/timeLogComputeUtils.js
function lunchOverlapMs(lunchBreak, windowStart, windowEnd) {
  if (!lunchBreak?.start || !lunchBreak?.end || windowStart == null || windowEnd == null) return 0;
  if (lunchBreak.auto && lunchBreak.deductible === false) return 0;
  const start = Math.max(new Date(lunchBreak.start).getTime(), new Date(windowStart).getTime());
  const end   = Math.min(new Date(lunchBreak.end).getTime(),   new Date(windowEnd).getTime());
  return Math.max(0, end - start);
}

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

// ── Plan one punch ────────────────────────────────────────────────────────────
// Returns { ok, reason?, segUpdates, approvalUpdates, newTimeLog, lines }
function planPunch(log) {
  const lines = [];
  const segUpdates = {};      // TimeLog segment field → new hours
  const approvalUpdates = []; // { id, hours }
  let deductedMs = 0;
  let changed = false;

  for (const a of log.approvals) {
    const seg = a.segmentType;
    const field = SEGMENT_FIELD[seg];
    if (!field) continue;

    if (a.status === "excluded") {
      lines.push(`    ${seg.padEnd(9)} excluded — untouched`);
      continue;
    }

    if (a.status === "approved") {
      const current = num(a.actualHours);
      const inMs  = a.approvedClockIn  ? new Date(a.approvedClockIn).getTime()  : null;
      const outMs = a.approvedClockOut ? new Date(a.approvedClockOut).getTime() : null;
      const lunchMs = lunchOverlapMs(log.lunchBreak, inMs, outMs);
      if (lunchMs === 0) {
        lines.push(`    ${seg.padEnd(9)} approved ${current}h — no lunch overlap, untouched`);
        continue;
      }
      const raw = (outMs - inMs) / 3600000;
      const target = r2(Math.max(0, raw - lunchMs / 3600000));
      deductedMs += lunchMs;
      if (near(current, target)) {
        lines.push(`    ${seg.padEnd(9)} approved ${current}h — already deducted, skip`);
        continue;
      }
      if (!near(current, r2(raw))) {
        return { ok: false, reason: `${seg} approved actualHours=${current}h matches neither window (${r2(raw)}h) nor window − lunch (${target}h)`, lines };
      }
      lines.push(`    ${seg.padEnd(9)} approved ${current}h − lunch ${r2(lunchMs / 3600000)}h → ${target}h  (TimeLogApproval ${a.id} + TimeLog.${field})`);
      approvalUpdates.push({ id: a.id, hours: target });
      segUpdates[field] = target;
      changed = true;
      continue;
    }

    // pending
    const current = num(log[field]);
    const winStart = a.segmentStart ? Math.max(new Date(log.timeIn).getTime(),  new Date(a.segmentStart).getTime()) : null;
    const winEnd   = a.segmentEnd   ? Math.min(new Date(log.timeOut).getTime(), new Date(a.segmentEnd).getTime())   : null;
    if (winStart == null || winEnd == null || winEnd <= winStart) {
      lines.push(`    ${seg.padEnd(9)} pending ${current ?? "null"}h — no worked window, untouched`);
      continue;
    }
    const lunchMs = lunchOverlapMs(log.lunchBreak, winStart, winEnd);
    if (lunchMs === 0) {
      lines.push(`    ${seg.padEnd(9)} pending ${current}h — no lunch overlap, untouched`);
      continue;
    }
    const raw = (winEnd - winStart) / 3600000;
    const target = r2(Math.max(0, raw - lunchMs / 3600000));
    deductedMs += lunchMs;
    if (current != null && near(current, target)) {
      lines.push(`    ${seg.padEnd(9)} pending ${current}h — already deducted, skip`);
      continue;
    }
    if (current == null || !near(current, r2(raw))) {
      return { ok: false, reason: `${seg} pending TimeLog.${field}=${current}h matches neither window (${r2(raw)}h) nor window − lunch (${target}h)`, lines };
    }
    lines.push(`    ${seg.padEnd(9)} pending ${current}h − lunch ${r2(lunchMs / 3600000)}h → ${target}h  (TimeLog.${field})`);
    segUpdates[field] = target;
    changed = true;
  }

  const finalSeg = (f) => (segUpdates[f] !== undefined ? segUpdates[f] : num(log[f]));
  const net = r2(Object.values(SEGMENT_FIELD).map(finalSeg).filter((h) => h != null).reduce((s, h) => s + h, 0));
  const newTimeLog = {
    ...segUpdates,
    netWorkedHours: net,
    lunchDeductionMinutes: Math.round(deductedMs / 60000),
  };

  return { ok: true, changed, segUpdates, approvalUpdates, newTimeLog, lines };
}

// ── Revert ────────────────────────────────────────────────────────────────────
async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup file at ${BACKUP_FILE}. Nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  for (const entry of backup.punches) {
    await prisma.$transaction([
      prisma.timeLog.update({
        where: { id: entry.timeLog.id },
        data: {
          driverAmSegmentHours:  entry.timeLog.driverAmSegmentHours,
          regularSegmentHours:   entry.timeLog.regularSegmentHours,
          driverPmSegmentHours:  entry.timeLog.driverPmSegmentHours,
          netWorkedHours:        entry.timeLog.netWorkedHours,
          lunchDeductionMinutes: entry.timeLog.lunchDeductionMinutes,
        },
      }),
      ...entry.approvals.map((a) =>
        prisma.timeLogApproval.update({
          where: { id: a.id },
          data: { actualHours: a.actualHours, scheduledHours: a.scheduledHours },
        })
      ),
    ]);
    console.log(`  Reverted TimeLog ${entry.timeLog.id} (+ ${entry.approvals.length} approval row(s))`);
  }
  console.log(`Done. Restored from ${BACKUP_FILE}.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== BB-092 Jasbleidi lunch deduction fix — ${ALL ? "STAGE 1 + 2" : "STAGE 1 (09/30 only)"} ===`);
  console.log(`DB target: ${describeDbTarget()}`);

  if (REVERT) {
    await revert();
    return;
  }
  console.log(DRY_RUN ? "DRY RUN — pass --apply to write changes\n" : "APPLYING changes\n");

  const blocked = TARGET_IDS.filter((id) => EXCLUDED.has(id));
  if (blocked.length) {
    console.log(`Refusing: excluded TimeLog(s) in target list: ${blocked.join(", ")}. Aborting.`);
    return;
  }

  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID }, select: { timeZone: true } });
  const tz = company?.timeZone || "America/Los_Angeles";

  const logs = await prisma.timeLog.findMany({
    where: { id: { in: TARGET_IDS } },
    include: {
      user: { select: { companyId: true } },
      approvals: { include: { cutoffPeriod: { select: { id: true, status: true } } } },
    },
    orderBy: { timeIn: "asc" },
  });

  const missing = TARGET_IDS.filter((id) => !logs.some((l) => l.id === id));
  if (missing.length) console.log(`⚠️  Not found (skipped): ${missing.join(", ")}\n`);

  const plans = [];
  for (const log of logs) {
    const date = moment(log.timeIn).tz(tz).format("YYYY-MM-DD");
    console.log(`--- ${date}  TimeLog ${log.id} ---`);

    if (log.userId !== USER_ID || log.user.companyId !== COMPANY_ID) {
      console.log("  SKIP — not Jasbleidi / not Piedmont.\n");
      continue;
    }
    if (!log.punchType.startsWith("DRIVER_AIDE") || !log.timeOut || !log.lunchBreak?.start || !log.lunchBreak?.end) {
      console.log(`  SKIP — not a completed Driver/Aide punch with a completed lunch (punchType=${log.punchType}).\n`);
      continue;
    }
    const closed = log.approvals.find((a) => a.cutoffPeriod && a.cutoffPeriod.status !== "open");
    if (closed) {
      console.log(`  SKIP — cutoff ${closed.cutoffPeriod.id} is ${closed.cutoffPeriod.status}.\n`);
      continue;
    }

    const plan = planPunch(log);
    plan.lines.forEach((l) => console.log(l));
    if (!plan.ok) {
      console.log(`  SKIP — unexpected state: ${plan.reason}\n`);
      continue;
    }
    if (!plan.changed) {
      console.log("  Nothing to change.\n");
      continue;
    }
    console.log(
      `  netWorkedHours ${num(log.netWorkedHours)}h → ${plan.newTimeLog.netWorkedHours}h` +
      `   lunchDeductionMinutes ${log.lunchDeductionMinutes ?? "null"} → ${plan.newTimeLog.lunchDeductionMinutes}\n`
    );
    plans.push({ log, plan });
  }

  console.log(`Punches to update: ${plans.length}`);

  if (DRY_RUN || plans.length === 0) {
    if (DRY_RUN) console.log("\nDry run only — no changes written. Re-run with --apply to write.");
    printReminder();
    return;
  }

  // ── Backup ───────────────────────────────────────────────────────────────
  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`\nBackup file already exists: ${BACKUP_FILE}`);
    console.log("Refusing to overwrite it (it holds the original values). Revert first, or move it aside. Aborting.");
    return;
  }
  const backup = {
    createdAt: new Date().toISOString(),
    stage: ALL ? "all" : "stage1",
    punches: plans.map(({ log, plan }) => ({
      timeLog: {
        id: log.id,
        driverAmSegmentHours:  num(log.driverAmSegmentHours),
        regularSegmentHours:   num(log.regularSegmentHours),
        driverPmSegmentHours:  num(log.driverPmSegmentHours),
        netWorkedHours:        num(log.netWorkedHours),
        lunchDeductionMinutes: log.lunchDeductionMinutes,
      },
      approvals: plan.approvalUpdates.map((u) => {
        const a = log.approvals.find((x) => x.id === u.id);
        return { id: a.id, actualHours: num(a.actualHours), scheduledHours: num(a.scheduledHours) };
      }),
    })),
  };
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written to ${BACKUP_FILE}`);

  // ── Apply ────────────────────────────────────────────────────────────────
  for (const { log, plan } of plans) {
    await prisma.$transaction([
      prisma.timeLog.update({ where: { id: log.id }, data: plan.newTimeLog }),
      ...plan.approvalUpdates.map((u) =>
        prisma.timeLogApproval.update({
          where: { id: u.id },
          data: { actualHours: u.hours, scheduledHours: u.hours },
        })
      ),
    ]);
    const after = await prisma.timeLog.findUnique({
      where: { id: log.id },
      select: { driverAmSegmentHours: true, regularSegmentHours: true, driverPmSegmentHours: true, netWorkedHours: true, lunchDeductionMinutes: true },
    });
    console.log(
      `  ✓ ${log.id}  AM=${num(after.driverAmSegmentHours) ?? "-"} REG=${num(after.regularSegmentHours) ?? "-"}` +
      ` PM=${num(after.driverPmSegmentHours) ?? "-"}  net=${num(after.netWorkedHours)}h  lunch=${after.lunchDeductionMinutes}min`
    );
  }

  console.log(`\nDone. Verify in Punch Logs and Cutoff Approval.`);
  console.log(`To undo: node scripts/fix-bb092-jasbleidi-lunch-deduction.js --revert${ALL ? " --all" : ""}`);
  printReminder();
}

function printReminder() {
  console.log("\n⚠️  Reminder: 2026-09-25 (cmuh1d8ix039jsj50p3a6zzpr) was NOT touched. Fix its lunch via admin edit");
  console.log("    BEFORE cutoff 09/15–09/28 is synced or approved — otherwise the BB-092 rule deducts 5.81h (→ 1.41h).");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
