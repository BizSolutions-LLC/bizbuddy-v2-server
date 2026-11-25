// scripts/fix-bizsolutions-reopen-sales-nov1-15-cutoff.js
//
// Reopens BizSolutions LLC's "Sales & Marketing" cutoff 2026-11-01 → 2026-11-15
// (stored calendar dates, as the cutoff page shows them): status → "open".
//
// Why a script: the app refuses any status change once a cutoff is "processed"
// (cutoffPeriodController.updateCutoffStatus). If the dry run shows "locked",
// you don't need this script: the cutoff page can reopen a locked period.
//
// What changes: ONLY CutoffPeriod.status (and updatedAt). Left as they are:
//   - punch approvals (approved / excluded decisions stay; pending ones can be
//     decided again once it's open);
//   - payroll export rows (PayrollExport / PayrollExportBatch). They are rebuilt
//     for this department when the period is set to processed again. Until then,
//     a payroll export download for these dates still shows the old numbers.
//   - the "Payroll Processed" notification already sent to employees.
//
// Default is a DRY RUN.
//
// Usage:
//   node scripts/fix-bizsolutions-reopen-sales-nov1-15-cutoff.js            # dry run
//   node scripts/fix-bizsolutions-reopen-sales-nov1-15-cutoff.js --apply    # backup + reopen
//   node scripts/fix-bizsolutions-reopen-sales-nov1-15-cutoff.js --revert   # back to the old status
//
// Backup: scripts/backup-bizsolutions-reopen-sales-nov1-15.json

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmvrxp9y0000grf5071x2nqvx"; // BizSolutions LLC (by id, never by name)
const DEPARTMENT_NAME = "Sales & Marketing";
const START = "2026-11-01";
const END = "2026-11-15";
const BACKUP = path.join(__dirname, "backup-bizsolutions-reopen-sales-nov1-15.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

async function revert() {
  if (!fs.existsSync(BACKUP)) {
    console.log(`No backup at ${BACKUP}. Nothing to revert.`);
    return;
  }
  const b = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  const n = await prisma.$executeRaw`
    UPDATE "CutoffPeriod" SET "status" = ${b.oldStatus}, "updatedAt" = NOW()
    WHERE "id" = ${b.id} AND "companyId" = ${COMPANY_ID}`;
  console.log(n ? `Cutoff ${b.id} set back to "${b.oldStatus}".` : `Cutoff ${b.id} not found.`);
}

async function main() {
  if (REVERT) return revert();

  const [company] = await prisma.$queryRaw`
    SELECT "id", "name", "timeZone" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) return console.log(`Company ${COMPANY_ID} not found.`);
  const tz = company.timeZone || "America/Los_Angeles";
  // Cutoff dates are stored as UTC-midnight calendar dates (see autoGenerateCutoffPeriodsJob):
  // read the UTC date, never convert to the company zone (that shifts them a day back).
  const local = (d) => new Date(d).toISOString().slice(0, 10);

  const depts = await prisma.$queryRaw`
    SELECT "id", "name" FROM "Department"
    WHERE "companyId" = ${COMPANY_ID} AND LOWER(TRIM("name")) = LOWER(${DEPARTMENT_NAME})`;
  if (depts.length !== 1) {
    console.log(`Expected one "${DEPARTMENT_NAME}" department, found ${depts.length}. Nothing done.`);
    return;
  }
  const dept = depts[0];

  const periods = await prisma.$queryRaw`
    SELECT "id", "periodStart", "periodEnd", "paymentDate", "status", "updatedAt"
    FROM "CutoffPeriod" WHERE "companyId" = ${COMPANY_ID} AND "departmentId" = ${dept.id}`;
  const matches = periods.filter((p) => local(p.periodStart) === START && local(p.periodEnd) === END);

  console.log(`\n${company.name}, ${dept.name} (${dept.id}), zone ${tz}`);
  if (matches.length !== 1) {
    console.log(`Expected one cutoff ${START} → ${END}, found ${matches.length}. Nothing done. This department's periods:`);
    periods
      .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
      .forEach((p) => console.log(`  ${local(p.periodStart)} → ${local(p.periodEnd)} | ${p.status} | ${p.id}`));
    return;
  }
  const p = matches[0];

  const approvals = await prisma.$queryRaw`
    SELECT "status", COUNT(*)::int AS n FROM "TimeLogApproval"
    WHERE "cutoffPeriodId" = ${p.id} GROUP BY "status"`;
  const [exp] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n, MAX("generatedAt") AS "generatedAt" FROM "PayrollExport"
    WHERE "companyId" = ${COMPANY_ID} AND "departmentId" = ${dept.id}
      AND "periodStart" = ${new Date(p.periodStart).toISOString().slice(0, 10)}::date
      AND "periodEnd" = ${new Date(p.periodEnd).toISOString().slice(0, 10)}::date`;

  console.log(`Cutoff ${local(p.periodStart)} → ${local(p.periodEnd)} | pay ${local(p.paymentDate)} | id ${p.id}`);
  console.log(`  status now: ${p.status} (last change ${moment.tz(p.updatedAt, tz).format("YYYY-MM-DD HH:mm")})`);
  console.log(`  approvals: ${approvals.map((a) => `${a.status} ${a.n}`).join(", ") || "none"} (kept as they are)`);
  console.log(
    `  payroll export rows: ${exp.n}${exp.n ? `, generated ${moment.tz(exp.generatedAt, tz).format("YYYY-MM-DD HH:mm")} (kept; rebuilt when processed again)` : ""}`
  );

  if (p.status === "open") return console.log("\nAlready open. Nothing to do.");
  if (p.status === "locked") {
    console.log("\nIt is LOCKED, not processed: you can reopen it from the cutoff page. This script will still do it with --apply.");
  }

  if (!APPLY) return console.log(`\nDry run only. Rerun with --apply to set it from "${p.status}" to "open".`);
  if (fs.existsSync(BACKUP)) {
    return console.log(`\nBackup ${BACKUP} already exists. Refusing to overwrite it.`);
  }

  fs.writeFileSync(
    BACKUP,
    JSON.stringify({ writtenAt: new Date().toISOString(), id: p.id, departmentId: dept.id, oldStatus: p.status, oldUpdatedAt: p.updatedAt }, null, 2)
  );
  const n = await prisma.$executeRaw`
    UPDATE "CutoffPeriod" SET "status" = 'open', "updatedAt" = NOW()
    WHERE "id" = ${p.id} AND "companyId" = ${COMPANY_ID} AND "status" = ${p.status}`;
  if (!n) {
    fs.unlinkSync(BACKUP);
    return console.log("\nStatus changed since the check. Nothing done; backup removed. Run the dry run again.");
  }
  console.log(`\nReopened: "${p.status}" → "open". Backup: ${BACKUP}. Undo with --revert.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
