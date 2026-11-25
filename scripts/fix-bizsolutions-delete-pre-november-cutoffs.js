// scripts/fix-bizsolutions-delete-pre-november-cutoffs.js
//
// BizSolutions LLC started using BizBuddy in November 2026. On 2026-11-12 the
// "Generate cutoff periods" feature (services/Cutoff/cutoffGenerationService.js)
// created the history back to 2025-12-31 and auto-marked every past period
// "processed" (no review, no approvals, no payroll export). This deletes those
// pre-November periods for EVERY BizSolutions LLC department (and company-wide
// periods, if any), so only real cutoffs remain.
//
// Which periods: company BizSolutions LLC (by id), stored period END date before
// 2026-11-01 (cutoff dates are UTC-midnight calendar dates, as the cutoff page
// shows them). Kept: 2026-11-01 → 11-16 (November punches, pending approvals)
// and everything after it.
//
// Safety: a period is deleted ONLY if all of these are 0. Otherwise it is listed
// as SKIPPED with the reason and left alone:
//   - TimeLogApproval rows on the period   (deleting the cutoff would cascade-delete them)
//   - CutoffOtBlock rows on the period     (cascade)
//   - CutoffFixedHours rows on the period  (cascade)
//   - PayrollExport rows for the same company + dates + department
//   - punches (TimeLog) by the department's employees (any company employee for a
//     company-wide period) with clock-in from the period start to the day after its end
// The checks run again inside the delete transaction.
//
// The nightly autoGenerateCutoffPeriodsJob only looks at the LATEST period, so it
// will not recreate the deleted ones.
//
// Default is a DRY RUN (prints what would be deleted, writes nothing).
//
// Usage:
//   node scripts/fix-bizsolutions-delete-pre-november-cutoffs.js            # dry run
//   node scripts/fix-bizsolutions-delete-pre-november-cutoffs.js --apply    # backup + delete
//   node scripts/fix-bizsolutions-delete-pre-november-cutoffs.js --revert   # re-insert from the backup
//
// Backup: scripts/backup-bizsolutions-pre-november-cutoffs.json (written before
// deleting; --apply refuses to run if it already exists, so a second run can't
// overwrite the first backup).

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmvrxp9y0000grf5071x2nqvx"; // BizSolutions LLC (by id, never by name)
const KEEP_FROM = "2026-11-01"; // delete periods whose stored end date is before this (first run used LA dates: same 19 deleted)
const BACKUP = path.join(__dirname, "backup-bizsolutions-pre-november-cutoffs.json");
const TX_TIMEOUT_MS = 2 * 60 * 1000;

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const isoDate = (d) => new Date(d).toISOString().slice(0, 10); // same as payrollExportService.toDateStr

async function blockers(db, p) {
  const [{ n: approvals }] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "TimeLogApproval" WHERE "cutoffPeriodId" = ${p.id}`;
  const [{ n: otBlocks }] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "CutoffOtBlock" WHERE "cutoffPeriodId" = ${p.id}`;
  const [{ n: fixedHours }] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "CutoffFixedHours" WHERE "cutoffPeriodId" = ${p.id}`;
  const [{ n: exports }] = await db.$queryRaw`
    SELECT COUNT(*)::int AS n FROM "PayrollExport"
    WHERE "companyId" = ${COMPANY_ID}
      AND "periodStart" = ${isoDate(p.periodStart)}::date
      AND "periodEnd" = ${isoDate(p.periodEnd)}::date
      AND "departmentId" IS NOT DISTINCT FROM ${p.departmentId}`;

  // Generous window: period start → one day after the period end.
  const from = new Date(p.periodStart);
  const to = new Date(new Date(p.periodEnd).getTime() + 24 * 60 * 60 * 1000);
  const [{ n: punches }] = p.departmentId
    ? await db.$queryRaw`
        SELECT COUNT(*)::int AS n FROM "TimeLog" t JOIN "User" u ON u."id" = t."userId"
        WHERE u."companyId" = ${COMPANY_ID} AND u."departmentId" = ${p.departmentId}
          AND t."timeIn" >= ${from} AND t."timeIn" <= ${to}`
    : await db.$queryRaw`
        SELECT COUNT(*)::int AS n FROM "TimeLog" t JOIN "User" u ON u."id" = t."userId"
        WHERE u."companyId" = ${COMPANY_ID}
          AND t."timeIn" >= ${from} AND t."timeIn" <= ${to}`;

  const reasons = [];
  if (approvals) reasons.push(`${approvals} approval(s)`);
  if (otBlocks) reasons.push(`${otBlocks} OT block(s)`);
  if (fixedHours) reasons.push(`${fixedHours} fixed-hours row(s)`);
  if (exports) reasons.push(`${exports} payroll export row(s)`);
  if (punches) reasons.push(`${punches} punch(es) in its dates`);
  return reasons;
}

async function revert() {
  if (!fs.existsSync(BACKUP)) {
    console.log(`No backup at ${BACKUP}. Nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  let restored = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const p of backup.deleted) {
        const n = await tx.$executeRaw`
          INSERT INTO "CutoffPeriod" ("id", "companyId", "departmentId", "periodStart", "periodEnd", "paymentDate",
                                      "frequency", "status", "createdBy", "isAutoGenerated", "createdAt", "updatedAt")
          VALUES (${p.id}, ${p.companyId}, ${p.departmentId}, ${new Date(p.periodStart)}, ${new Date(p.periodEnd)},
                  ${new Date(p.paymentDate)}, ${p.frequency}, ${p.status}, ${p.createdBy}, ${p.isAutoGenerated},
                  ${new Date(p.createdAt)}, ${new Date(p.updatedAt)})
          ON CONFLICT ("id") DO NOTHING`;
        restored += n;
      }
    },
    { timeout: TX_TIMEOUT_MS }
  );
  console.log(`Re-inserted ${restored} of ${backup.deleted.length} period(s) from ${BACKUP}.`);
  console.log("The backup file is kept. Delete or rename it by hand before running --apply again.");
}

async function main() {
  if (REVERT) return revert();

  const [company] = await prisma.$queryRaw`
    SELECT "id", "name", "timeZone" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) {
    console.log(`Company ${COMPANY_ID} not found.`);
    return;
  }
  const tz = company.timeZone || "America/Los_Angeles";
  // Cutoff dates are stored as UTC-midnight calendar dates: read the UTC date
  // (converting to the company zone shifts them a day back).
  const local = (d) => isoDate(d);

  const all = await prisma.$queryRaw`
    SELECT cp."id", cp."companyId", cp."departmentId", cp."periodStart", cp."periodEnd", cp."paymentDate",
           cp."frequency", cp."status", cp."createdBy", cp."isAutoGenerated", cp."createdAt", cp."updatedAt",
           d."name" AS "departmentName"
    FROM "CutoffPeriod" cp
    LEFT JOIN "Department" d ON d."id" = cp."departmentId"
    WHERE cp."companyId" = ${COMPANY_ID}
    ORDER BY d."name" NULLS FIRST, cp."periodStart"`;

  const candidates = all.filter((p) => local(p.periodEnd) < KEEP_FROM);
  const kept = all.length - candidates.length;

  console.log(`\n${company.name} (${company.id}), zone ${tz}`);
  console.log(`Cutoff periods: ${all.length} total, ${candidates.length} end before ${KEEP_FROM}, ${kept} kept.`);
  console.log(APPLY ? "Mode: APPLY (backup + delete)\n" : "Mode: DRY RUN (nothing is written)\n");

  const toDelete = [];
  const skipped = [];
  let currentDept;
  for (const p of candidates) {
    const dept = p.departmentName || "company-wide (no department)";
    if (dept !== currentDept) {
      console.log(dept);
      currentDept = dept;
    }
    const reasons = await blockers(prisma, p);
    const line = `${local(p.periodStart)} → ${local(p.periodEnd)} | ${p.status} | ${p.isAutoGenerated ? "auto" : "by hand"} | created ${moment.tz(p.createdAt, tz).format("YYYY-MM-DD HH:mm")} | ${p.id}`;
    if (reasons.length) {
      skipped.push({ p, reasons });
      console.log(`  SKIP   ${line}  ← ${reasons.join(", ")}`);
    } else {
      toDelete.push(p);
      console.log(`  DELETE ${line}`);
    }
  }

  const byStatus = toDelete.reduce((acc, p) => ((acc[p.status] = (acc[p.status] || 0) + 1), acc), {});
  console.log(`\nTo delete: ${toDelete.length} (${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(", ") || "none"}), skipped: ${skipped.length}`);
  if (skipped.length) console.log("Skipped periods have data and are left alone. Tell Claude if any of them should go too.");

  if (!APPLY) {
    console.log("\nDry run only. Rerun with --apply to back up and delete.");
    return;
  }
  if (!toDelete.length) {
    console.log("Nothing to delete.");
    return;
  }
  if (fs.existsSync(BACKUP)) {
    console.log(`\nBackup ${BACKUP} already exists. Refusing to overwrite it. Rename it first if you really want to run again.`);
    return;
  }

  const serial = (p) => ({
    id: p.id, companyId: p.companyId, departmentId: p.departmentId, departmentName: p.departmentName,
    periodStart: new Date(p.periodStart).toISOString(), periodEnd: new Date(p.periodEnd).toISOString(),
    paymentDate: new Date(p.paymentDate).toISOString(), frequency: p.frequency, status: p.status,
    createdBy: p.createdBy, isAutoGenerated: p.isAutoGenerated,
    createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(p.updatedAt).toISOString(),
  });
  fs.writeFileSync(
    BACKUP,
    JSON.stringify({ writtenAt: new Date().toISOString(), companyId: COMPANY_ID, keepFrom: KEEP_FROM, deleted: toDelete.map(serial) }, null, 2)
  );
  console.log(`\nBackup written: ${BACKUP}`);

  let deleted = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const p of toDelete) {
          const reasons = await blockers(tx, p); // re-check inside the transaction
          if (reasons.length) throw new Error(`Period ${p.id} gained data since the check (${reasons.join(", ")}). Nothing deleted.`);
          deleted += await tx.$executeRaw`
            DELETE FROM "CutoffPeriod" WHERE "id" = ${p.id} AND "companyId" = ${COMPANY_ID}`;
        }
      },
      { timeout: TX_TIMEOUT_MS }
    );
  } catch (e) {
    // Rolled back: nothing was deleted, so the backup is removed and --apply can run again.
    fs.unlinkSync(BACKUP);
    console.log("Transaction rolled back, nothing deleted; backup file removed.");
    throw e;
  }
  console.log(`Deleted ${deleted} cutoff period(s). Undo with --revert.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
