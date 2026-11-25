// scripts/fix-padpro-nov14-training-hours.js
//
// PadPro (Piedmont Adult Day Program) training day, Friday 2026-11-14.
// Everyone who punched that day (company zone) attended the training. Each
// attendee's TRAINING punch is set to 8:00 AM → 4:30 PM = 8.50h and approved as
// Training. No punch that day = did not attend = not touched.
//
// Skipped: the employees already updated by hand (two, with longer training hours),
// passed by name with --skip so no names are stored in this file. Each name must
// match exactly one PadPro person or nothing is done.
//
// How (the same way the cutoff page records a changed punch, so Reset still works):
//   TimeLog:          originalTimeIn/Out keep the real punch (only if empty),
//                     timeIn/Out = 8:00 / 4:30, net/gross/scheduled = 8.50,
//                     lunch 0, isApproved = true;
//   TimeLogApproval:  approved, approvedBy = --approver, approvedClockIn/Out = 8:00 / 4:30,
//                     scheduledHours = actualHours = 8.50, note appended.
// Reset on the cutoff page later brings back the real punch times.
//
// Left alone and LISTED (decide by hand):
//   - punches that are not TRAINING (Regular / Driver/Aide): counted for now;
//   - employees with 2+ punches on Nov 14;
//   - punches with no clock-out;
//   - punches whose approval is excluded, missing, or in a locked/processed cutoff;
//   - punches that carry a lunch the company would deduct (would pay < 8.50h).
//
// After --apply: press Sync on the Nov 11–24 cutoff(s) so overtime is recalculated,
// then lock + process again (rebuilds the payroll export).
//
// Default is a DRY RUN. Raw SQL, so it works with any generated Prisma client.
//
// Usage:
//   node scripts/fix-padpro-nov14-training-hours.js --skip "First Last" --skip "First Last"            # dry run
//   node scripts/fix-padpro-nov14-training-hours.js --skip "..." --skip "..." --apply --approver <admin email>
//   node scripts/fix-padpro-nov14-training-hours.js --revert                                           # restore from backup
//
// Backup: scripts/backup-padpro-nov14-training-hours.json

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program (by id, never by name)
const DAY = "2026-11-14";
const NEW_IN = "08:00";
const NEW_OUT = "16:30";
const HOURS = 8.5;
const SKIP_NAMES = process.argv.flatMap((a, i) => (a === "--skip" && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const NOTE = "Training day 2026-11-14: set to 8:00 AM – 4:30 PM (8.50h) by script.";
const BACKUP = path.join(__dirname, "backup-padpro-nov14-training-hours.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const approverArg = process.argv.indexOf("--approver");
const APPROVER_EMAIL = approverArg > -1 ? process.argv[approverArg + 1] : null;

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

// Same lunch rule as timeLogComputeService.lunchDeductionFor (REGULAR + TRAINING).
function lunchDeduction(tl, minimumLunch) {
  if (tl.autoLunchDeductionMinutes != null) return tl.autoLunchDeductionMinutes;
  if (tl.autoLunchApplied) return 0;
  const lb = tl.lunchBreak;
  const mins = lb && lb.start && lb.end ? Math.max(0, (new Date(lb.end) - new Date(lb.start)) / 60000) : 0;
  return mins > 0 ? Math.max(mins, minimumLunch) : minimumLunch;
}

// Deductible coffee minutes (auto non-deductible ones don't count), like sumCoffeeBreakMinutes.
function coffeeMinutes(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((t, b) => {
    if (!b || !b.start || !b.end || (b.auto && b.deductible === false)) return t;
    const d = (new Date(b.end) - new Date(b.start)) / 60000;
    return d > 0 ? t + d : t;
  }, 0);
}

async function revert() {
  if (!fs.existsSync(BACKUP)) return console.log(`No backup at ${BACKUP}. Nothing to revert.`);
  const b = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  await prisma.$transaction(
    async (tx) => {
      for (const r of b.rows) {
        const t = r.timeLog;
        await tx.$executeRaw`
          UPDATE "TimeLog" SET
            "timeIn" = ${new Date(t.timeIn)}, "timeOut" = ${t.timeOut ? new Date(t.timeOut) : null},
            "originalTimeIn" = ${t.originalTimeIn ? new Date(t.originalTimeIn) : null},
            "originalTimeOut" = ${t.originalTimeOut ? new Date(t.originalTimeOut) : null},
            "netWorkedHours" = ${t.netWorkedHours}::numeric, "grossHours" = ${t.grossHours}::numeric,
            "scheduledHours" = ${t.scheduledHours}::numeric, "lunchDeductionMinutes" = ${t.lunchDeductionMinutes},
            "isApproved" = ${t.isApproved}, "updatedAt" = NOW()
          WHERE "id" = ${t.id}`;
        const a = r.approval;
        await tx.$executeRaw`
          UPDATE "TimeLogApproval" SET
            "status" = ${a.status}, "approvedBy" = ${a.approvedBy},
            "approvedAt" = ${a.approvedAt ? new Date(a.approvedAt) : null},
            "approvedClockIn" = ${a.approvedClockIn ? new Date(a.approvedClockIn) : null},
            "approvedClockOut" = ${a.approvedClockOut ? new Date(a.approvedClockOut) : null},
            "scheduledHours" = ${a.scheduledHours}::numeric, "actualHours" = ${a.actualHours}::numeric,
            "notes" = ${a.notes}, "updatedAt" = NOW()
          WHERE "id" = ${a.id}`;
      }
    },
    { timeout: 120000 }
  );
  console.log(`Restored ${b.rows.length} punch(es) and approval(s). Press Sync on the cutoff to recalculate overtime.`);
}

async function main() {
  if (REVERT) return revert();
  if (!SKIP_NAMES.length) {
    console.log('No --skip given. Pass the employees already updated, e.g. --skip "First Last" --skip "First Last". Nothing done.');
    return;
  }

  const [company] = await prisma.$queryRaw`
    SELECT "id", "name", "timeZone", "minimumLunchMinutes" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) return console.log(`Company ${COMPANY_ID} not found.`);
  const tz = company.timeZone || "America/Los_Angeles";
  const minimumLunch = company.minimumLunchMinutes ?? 60;
  const dayStart = moment.tz(DAY, tz).startOf("day").toDate();
  const dayEnd = moment.tz(DAY, tz).endOf("day").toDate();
  const newIn = moment.tz(`${DAY} ${NEW_IN}`, "YYYY-MM-DD HH:mm", tz).toDate();
  const newOut = moment.tz(`${DAY} ${NEW_OUT}`, "YYYY-MM-DD HH:mm", tz).toDate();
  const fmt = (d) => (d ? moment.tz(d, tz).format("MMM D h:mm A") : "—");

  // Every punch with clock-in on Nov 14 (company zone), real people only.
  const punches = await prisma.$queryRaw`
    SELECT t."id", t."userId", t."timeIn", t."timeOut", t."originalTimeIn", t."originalTimeOut",
           t."punchType"::text AS "punchType", t."netWorkedHours", t."grossHours", t."scheduledHours",
           t."lunchDeductionMinutes", t."isApproved", t."lunchBreak", t."coffeeBreaks",
           t."autoLunchApplied", t."autoLunchDeductionMinutes",
           u."email", p."firstName", p."lastName"
    FROM "TimeLog" t
    JOIN "User" u ON u."id" = t."userId"
    LEFT JOIN "UserProfile" p ON p."userId" = u."id"
    WHERE u."companyId" = ${COMPANY_ID} AND u."isSystemAgent" = false
      AND t."timeIn" >= ${dayStart} AND t."timeIn" <= ${dayEnd}
    ORDER BY p."lastName", p."firstName", t."timeIn"`;

  const nameOf = (r) => `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email;

  // Skip list: each name must match exactly one PadPro person.
  const people = await prisma.$queryRaw`
    SELECT u."id", p."firstName", p."lastName" FROM "User" u
    LEFT JOIN "UserProfile" p ON p."userId" = u."id"
    WHERE u."companyId" = ${COMPANY_ID} AND u."isSystemAgent" = false`;
  const skipIds = new Set();
  for (const n of SKIP_NAMES) {
    const m = people.filter((u) => norm(`${u.firstName} ${u.lastName}`) === norm(n));
    if (m.length !== 1) {
      console.log(`Skip name "${n}" matches ${m.length} PadPro people (expected 1). Nothing done.`);
      return;
    }
    skipIds.add(m[0].id);
  }

  const approvals = punches.length
    ? await prisma.$queryRaw`
        SELECT a."id", a."timeLogId", a."status", a."segmentType", a."approvedBy", a."approvedAt",
               a."approvedClockIn", a."approvedClockOut", a."scheduledHours", a."actualHours", a."notes",
               c."status" AS "cutoffStatus", c."id" AS "cutoffId"
        FROM "TimeLogApproval" a
        LEFT JOIN "CutoffPeriod" c ON c."id" = a."cutoffPeriodId"
        WHERE a."timeLogId" IN (${Prisma.join(punches.map((p) => p.id))})`
    : [];
  const apprByLog = new Map();
  for (const a of approvals) {
    if (!apprByLog.has(a.timeLogId)) apprByLog.set(a.timeLogId, []);
    apprByLog.get(a.timeLogId).push(a);
  }
  const countByUser = new Map();
  for (const p of punches) countByUser.set(p.userId, (countByUser.get(p.userId) || 0) + 1);

  const groups = { update: [], skipped: [], notTraining: [], problem: [] };
  for (const p of punches) {
    const line = `${nameOf(p)} | ${p.punchType} | ${fmt(p.timeIn)} → ${fmt(p.timeOut)} | now ${p.netWorkedHours ?? "—"}h`;
    const appr = apprByLog.get(p.id) || [];
    if (skipIds.has(p.userId)) { groups.skipped.push(`${line} | approval ${appr.map((a) => `${a.status} ${a.actualHours ?? "—"}h`).join(", ") || "none"}`); continue; }
    if (p.punchType !== "TRAINING") { groups.notTraining.push(line); continue; }
    if (countByUser.get(p.userId) > 1) { groups.problem.push(`${line} | 2+ punches that day`); continue; }
    if (!p.timeOut) { groups.problem.push(`${line} | no clock-out`); continue; }
    if (appr.length !== 1) { groups.problem.push(`${line} | ${appr.length} approval rows`); continue; }
    const a = appr[0];
    if (a.cutoffStatus !== "open") { groups.problem.push(`${line} | cutoff ${a.cutoffStatus || "none"}`); continue; }
    if (a.status === "excluded" || a.status === "rejected") { groups.problem.push(`${line} | approval ${a.status}`); continue; }
    const lunch = lunchDeduction(p, minimumLunch);
    const coffee = coffeeMinutes(p.coffeeBreaks);
    if (lunch + coffee > 0) { groups.problem.push(`${line} | lunch ${Math.round(lunch)}m + coffee ${Math.round(coffee)}m would be deducted`); continue; }
    groups.update.push({ p, a, line: `${line} | approval ${a.status} ${a.actualHours ?? "—"}h → 8.50h` });
  }

  console.log(`\n${company.name}, ${DAY} (${tz}): ${punches.length} punch(es), ${new Set(punches.map((p) => p.userId)).size} people. Minimum lunch: ${minimumLunch} min.`);
  console.log(`\nWILL UPDATE to 8:00 AM → 4:30 PM, 8.50h, approved as Training (${groups.update.length}):`);
  groups.update.forEach((g) => console.log(`  ${g.line}`));
  console.log(`\nSKIPPED, already updated (${groups.skipped.length}):`);
  groups.skipped.forEach((l) => console.log(`  ${l}`));
  console.log(`\nNOT TRAINING, not touched (${groups.notTraining.length}):`);
  groups.notTraining.forEach((l) => console.log(`  ${l}`));
  console.log(`\nNEEDS A LOOK, not touched (${groups.problem.length}):`);
  groups.problem.forEach((l) => console.log(`  ${l}`));

  if (!groups.update.length) return console.log("\nNothing to update.");
  if (!APPLY) return console.log(`\nDry run only. Rerun with --apply --approver <admin email> to update ${groups.update.length} punch(es).`);

  if (!APPROVER_EMAIL) return console.log('\n--apply needs --approver <email of a PadPro admin>. Nothing done.');
  const approvers = await prisma.$queryRaw`
    SELECT "id", "email", "role"::text AS "role" FROM "User"
    WHERE "companyId" = ${COMPANY_ID} AND LOWER("email") = LOWER(${APPROVER_EMAIL})
      AND "role"::text IN ('admin', 'superadmin')`;
  if (approvers.length !== 1) return console.log(`\nApprover ${APPROVER_EMAIL}: ${approvers.length} PadPro admin account(s) found (expected 1). Nothing done.`);
  const approverId = approvers[0].id;

  if (fs.existsSync(BACKUP)) return console.log(`\nBackup ${BACKUP} already exists. Refusing to overwrite it.`);
  const num = (v) => (v == null ? null : String(v));
  fs.writeFileSync(
    BACKUP,
    JSON.stringify(
      {
        writtenAt: new Date().toISOString(),
        rows: groups.update.map(({ p, a }) => ({
          timeLog: {
            id: p.id, timeIn: p.timeIn, timeOut: p.timeOut, originalTimeIn: p.originalTimeIn, originalTimeOut: p.originalTimeOut,
            netWorkedHours: num(p.netWorkedHours), grossHours: num(p.grossHours), scheduledHours: num(p.scheduledHours),
            lunchDeductionMinutes: p.lunchDeductionMinutes, isApproved: p.isApproved,
          },
          approval: {
            id: a.id, status: a.status, approvedBy: a.approvedBy, approvedAt: a.approvedAt,
            approvedClockIn: a.approvedClockIn, approvedClockOut: a.approvedClockOut,
            scheduledHours: num(a.scheduledHours), actualHours: num(a.actualHours), notes: a.notes,
          },
        })),
      },
      null,
      2
    )
  );

  await prisma.$transaction(
    async (tx) => {
      for (const { p, a } of groups.update) {
        await tx.$executeRaw`
          UPDATE "TimeLog" SET
            "originalTimeIn" = COALESCE("originalTimeIn", "timeIn"),
            "originalTimeOut" = COALESCE("originalTimeOut", "timeOut"),
            "timeIn" = ${newIn}, "timeOut" = ${newOut},
            "netWorkedHours" = ${HOURS}, "grossHours" = ${HOURS}, "scheduledHours" = ${HOURS},
            "lunchDeductionMinutes" = 0, "isApproved" = true, "calculatedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${p.id} AND "punchType"::text = 'TRAINING'`;
        const note = a.notes ? `${a.notes} | ${NOTE}` : NOTE;
        await tx.$executeRaw`
          UPDATE "TimeLogApproval" SET
            "status" = 'approved', "approvedBy" = ${approverId}, "approvedAt" = NOW(),
            "approvedClockIn" = ${newIn}, "approvedClockOut" = ${newOut},
            "scheduledHours" = ${HOURS}, "actualHours" = ${HOURS}, "notes" = ${note}, "updatedAt" = NOW()
          WHERE "id" = ${a.id} AND "status" = ${a.status}`;
      }
    },
    { timeout: 120000 }
  );
  console.log(`\nUpdated ${groups.update.length} punch(es). Backup: ${BACKUP}. Undo with --revert.`);
  console.log("Next: press Sync on the Nov 11–24 cutoff(s) to recalculate overtime, then lock + process again.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
