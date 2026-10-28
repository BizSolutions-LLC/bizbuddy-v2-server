// scripts/delete-bb086-april-live-timelogs-2026-04-01_2026-04-14.js
//
// BB-086 follow-up — STEP 2 of 2. Deletes the April 1–14, 2026 live TimeLogs that
// were saved by backup-bb086-april-live-timelogs-2026-04-01_2026-04-14.js, so the
// company-approved CSV can be re-uploaded via the Backtrack import.
//
// DRY-RUN BY DEFAULT — it only prints what it would do. To actually delete:
//   node scripts/delete-bb086-april-live-timelogs-2026-04-01_2026-04-14.js --confirm --expect=<N>
// where <N> is the TimeLog count printed by the dry run (guards against drift).
//
// It deletes ONLY the TimeLog ids listed in the backup JSON, never a date-range
// query, so punches created after the backup are untouched. Cascades remove each
// TimeLog's TimeLogApproval, Overtime, ContestTimeLog and LiveUser rows;
// RequestedTimeLog.createdTimeLogId is nulled.
//
// Aborts (deletes nothing) if:
//   - the backup file is missing
//   - any linked CutoffPeriod is not "open" (reopen it first; the import also
//     refuses locked periods)
//   - any target punch is an open LiveUser session
//   - a target TimeLog now has approvals/overtime/contests that the backup lacks
//     (data changed since the backup — take a fresh backup)
//
// NOT touched: CutoffOtBlock rows (they are not cascade-linked to TimeLog). If the
// re-import totals look off, stale OT blocks for these periods are the first thing
// to check; the backup lists them under "cutoffOtBlocks".
//
// Usage (dry run): node scripts/delete-bb086-april-live-timelogs-2026-04-01_2026-04-14.js [--from=YYYY-MM-DD --to=YYYY-MM-DD]

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

// Range defaults to 2026-04-01..2026-04-14; pass --from / --to (YYYY-MM-DD) to
// target another cutoff period. Must match the range the backup was taken with.
const RANGE_START = arg("from") || "2026-04-01";
const RANGE_END = arg("to") || "2026-04-14";
const RANGE_FLAGS = `--from=${RANGE_START} --to=${RANGE_END}`;
const BACKUP_FILE = path.join(__dirname, `backup-bb086-april-live-timelogs-${RANGE_START}_${RANGE_END}.json`);
const CHUNK = 200;
const CONFIRM = process.argv.includes("--confirm");

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function main() {
  console.log(`=== BB-086 April live TimeLogs DELETE — ${RANGE_START} to ${RANGE_END} ===`);
  console.log(CONFIRM ? "MODE: CONFIRMED DELETE" : "MODE: dry run (no changes)");

  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`\nBackup not found: ${BACKUP_FILE}`);
    console.log("Run the backup script first. Nothing deleted.");
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  console.log(`\nBackup: generated ${backup.generatedAt} | company ${backup.company.name} (${backup.company.id})`);

  const backedUp = new Map(backup.timeLogs.map((t) => [t.id, t]));
  const ids = [...backedUp.keys()];
  console.log(`TimeLogs in backup: ${ids.length}`);

  // ── Re-verify current state ─────────────────────────────────────────────
  const current = [];
  for (const part of chunks(ids, CHUNK)) {
    current.push(
      ...(await prisma.timeLog.findMany({
        where: { id: { in: part } },
        include: { approvals: { select: { id: true, cutoffPeriodId: true } }, overtime: { select: { id: true } }, contests: { select: { id: true } } },
      }))
    );
  }
  const alreadyGone = ids.length - current.length;
  console.log(`Still present in DB: ${current.length}${alreadyGone ? ` (${alreadyGone} already gone)` : ""}`);
  if (current.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const problems = [];

  // 1. Children added since the backup
  for (const t of current) {
    const b = backedUp.get(t.id);
    const missing = (label, now, then) => {
      const had = new Set(then.map((x) => x.id));
      const extra = now.filter((x) => !had.has(x.id));
      if (extra.length) problems.push(`TimeLog ${t.id}: ${extra.length} ${label} row(s) not in backup`);
    };
    missing("approval", t.approvals, b.approvals);
    missing("overtime", t.overtime, b.overtime);
    missing("contest", t.contests, b.contests);
  }

  // 2. Cutoff period status
  const periodIds = [...new Set(current.flatMap((t) => t.approvals.map((a) => a.cutoffPeriodId)).filter(Boolean))];
  const periods = await prisma.cutoffPeriod.findMany({ where: { id: { in: periodIds } } });
  console.log("\nCutoff periods involved:");
  for (const p of periods) {
    console.log(`  ${p.id} | ${p.periodStart.toISOString().slice(0, 10)}..${p.periodEnd.toISOString().slice(0, 10)} | status=${p.status}`);
    if (p.status !== "open") problems.push(`CutoffPeriod ${p.id} is "${p.status}" — reopen it before deleting`);
  }

  // 3. Open sessions
  const live = await prisma.liveUser.findMany({ where: { timeLogId: { in: current.map((t) => t.id) } } });
  for (const l of live) problems.push(`TimeLog ${l.timeLogId} is an open LiveUser session (user ${l.userId})`);

  const approvalCount = current.reduce((n, t) => n + t.approvals.length, 0);
  const overtimeCount = current.reduce((n, t) => n + t.overtime.length, 0);
  const contestCount = current.reduce((n, t) => n + t.contests.length, 0);
  console.log(`\nWould delete: ${current.length} TimeLogs`);
  console.log(`  cascade: ${approvalCount} approvals, ${overtimeCount} overtime, ${contestCount} contests, ${live.length} live sessions`);

  if (problems.length) {
    console.log(`\nABORTED — ${problems.length} problem(s), nothing deleted:`);
    for (const p of problems.slice(0, 30)) console.log(`  - ${p}`);
    if (problems.length > 30) console.log(`  ... and ${problems.length - 30} more`);
    return;
  }

  if (!CONFIRM) {
    console.log("\nDry run complete. No changes made.");
    console.log(`To delete: node scripts/delete-bb086-april-live-timelogs-2026-04-01_2026-04-14.js ${RANGE_FLAGS} --confirm --expect=${current.length}`);
    return;
  }

  const expect = Number(arg("expect"));
  if (!Number.isInteger(expect) || expect !== current.length) {
    console.log(`\nABORTED — --expect=${arg("expect")} does not match ${current.length}. Nothing deleted.`);
    return;
  }

  // ── Delete (single transaction: all or nothing) ─────────────────────────
  const currentIds = current.map((t) => t.id);
  const deleted = await prisma.$transaction(
    async (tx) => {
      let n = 0;
      for (const part of chunks(currentIds, CHUNK)) {
        const r = await tx.timeLog.deleteMany({ where: { id: { in: part } } });
        n += r.count;
      }
      if (n !== currentIds.length) throw new Error(`Deleted ${n} but expected ${currentIds.length} — rolling back`);
      return n;
    },
    { timeout: 120000, maxWait: 20000 }
  );

  console.log(`\nDELETED ${deleted} TimeLogs (with cascades). Backup: ${BACKUP_FILE}`);
  console.log(`Next: re-upload the approved CSV via the Backtrack import for ${RANGE_START}..${RANGE_END}.`);
}

main()
  .catch((err) => {
    console.error("Script failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
