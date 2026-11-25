// scripts/fix-padpro-reopen-nov11-24-cutoff.js
//
// Reopens Piedmont Adult Day Program's (PadPro) cutoff 2026-11-11 → 2026-11-24
// (stored calendar dates, as the cutoff page shows them): status → "open".
// Every PadPro department with that period, unless --department narrows it.
//
// Why a script: the app refuses any status change once a cutoff is "processed"
// (cutoffPeriodController.updateCutoffStatus). A LOCKED period can be reopened
// from the cutoff page; the script still handles it with --apply.
//
// Check in the dry run: the period ended 2026-11-24. If it was CREATED today with
// no approvals, the nightly generator made it "processed" on birth
// (cutoffGenerationService: periodEnd < today → processed) — nobody processed it.
//
// What changes: ONLY CutoffPeriod.status (and updatedAt). Left as they are:
//   - punch approvals (approved / excluded stay; pending ones can be decided once open);
//   - payroll export rows (PayrollExport / PayrollExportBatch). They are rebuilt when
//     the period is set to processed again; until then a payroll export download for
//     these dates still shows the old numbers;
//   - the "Payroll Processed" notification already sent to employees.
//
// Default is a DRY RUN.
//
// Usage:
//   node scripts/fix-padpro-reopen-nov11-24-cutoff.js                          # dry run
//   node scripts/fix-padpro-reopen-nov11-24-cutoff.js --department "Name"      # dry run, one department
//   node scripts/fix-padpro-reopen-nov11-24-cutoff.js --apply                  # backup + reopen
//   node scripts/fix-padpro-reopen-nov11-24-cutoff.js --revert                 # back to the old statuses
//
// Backup: scripts/backup-padpro-reopen-nov11-24.json

const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program (by id, never by name)
const START = "2026-11-11";
const END = "2026-11-24";
const BACKUP = path.join(__dirname, "backup-padpro-reopen-nov11-24.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const deptArg = process.argv.indexOf("--department");
const DEPARTMENT_NAME = deptArg > -1 ? process.argv[deptArg + 1] : null;

// Cutoff dates are stored as UTC-midnight calendar dates: read the UTC date,
// never convert to the company zone (that shifts them a day back).
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

async function revert() {
  if (!fs.existsSync(BACKUP)) {
    console.log(`No backup at ${BACKUP}. Nothing to revert.`);
    return;
  }
  const b = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  for (const p of b.periods) {
    const n = await prisma.$executeRaw`
      UPDATE "CutoffPeriod" SET "status" = ${p.oldStatus}, "updatedAt" = NOW()
      WHERE "id" = ${p.id} AND "companyId" = ${COMPANY_ID}`;
    console.log(n ? `Cutoff ${p.id} (${p.department}) set back to "${p.oldStatus}".` : `Cutoff ${p.id} not found.`);
  }
}

async function main() {
  if (REVERT) return revert();
  if (deptArg > -1 && !DEPARTMENT_NAME) return console.log('--department needs a name, e.g. --department "Day Program".');

  const [company] = await prisma.$queryRaw`
    SELECT "id", "name", "timeZone" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) return console.log(`Company ${COMPANY_ID} not found.`);
  const tz = company.timeZone || "America/Los_Angeles";
  const at = (d) => (d ? moment.tz(d, tz).format("YYYY-MM-DD HH:mm") : "—");

  const depts = await prisma.$queryRaw`
    SELECT "id", "name" FROM "Department" WHERE "companyId" = ${COMPANY_ID}`;
  const deptName = new Map(depts.map((d) => [d.id, d.name]));

  const periods = await prisma.$queryRaw`
    SELECT "id", "departmentId", "periodStart", "periodEnd", "paymentDate", "status", "createdAt", "updatedAt"
    FROM "CutoffPeriod" WHERE "companyId" = ${COMPANY_ID}`;
  let matches = periods.filter((p) => isoDate(p.periodStart) === START && isoDate(p.periodEnd) === END);
  const nameOf = (p) => (p.departmentId ? deptName.get(p.departmentId) || p.departmentId : "(company-wide)");

  if (DEPARTMENT_NAME) {
    matches = matches.filter((p) => nameOf(p).trim().toLowerCase() === DEPARTMENT_NAME.trim().toLowerCase());
  }

  console.log(`\n${company.name} (${COMPANY_ID}), zone ${tz}${DEPARTMENT_NAME ? `, department "${DEPARTMENT_NAME}"` : ""}`);
  if (matches.length === 0) {
    console.log(`No cutoff ${START} → ${END} found. Nothing done. PadPro periods around those dates:`);
    periods
      .filter((p) => isoDate(p.periodEnd) >= "2026-10-15" && isoDate(p.periodStart) <= "2026-12-15")
      .sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart))
      .forEach((p) => console.log(`  ${isoDate(p.periodStart)} → ${isoDate(p.periodEnd)} | ${p.status} | ${nameOf(p)} | ${p.id}`));
    return;
  }

  const toReopen = [];
  for (const p of matches) {
    const approvals = await prisma.$queryRaw`
      SELECT "status", COUNT(*)::int AS n FROM "TimeLogApproval"
      WHERE "cutoffPeriodId" = ${p.id} GROUP BY "status"`;
    const [exp] = p.departmentId
      ? await prisma.$queryRaw`
          SELECT COUNT(*)::int AS n, MAX("generatedAt") AS "generatedAt" FROM "PayrollExport"
          WHERE "companyId" = ${COMPANY_ID} AND "departmentId" = ${p.departmentId}
            AND "periodStart" = ${isoDate(p.periodStart)}::date AND "periodEnd" = ${isoDate(p.periodEnd)}::date`
      : await prisma.$queryRaw`
          SELECT COUNT(*)::int AS n, MAX("generatedAt") AS "generatedAt" FROM "PayrollExport"
          WHERE "companyId" = ${COMPANY_ID}
            AND "periodStart" = ${isoDate(p.periodStart)}::date AND "periodEnd" = ${isoDate(p.periodEnd)}::date`;
    const total = approvals.reduce((s, a) => s + a.n, 0);
    const bornProcessed = p.status === "processed" && total === 0 && Math.abs(new Date(p.updatedAt) - new Date(p.createdAt)) < 60000;

    console.log(`\n${nameOf(p)} | ${isoDate(p.periodStart)} → ${isoDate(p.periodEnd)} | pay ${isoDate(p.paymentDate)} | id ${p.id}`);
    console.log(`  status now: ${p.status} | created ${at(p.createdAt)} | last change ${at(p.updatedAt)}`);
    console.log(`  approvals: ${approvals.map((a) => `${a.status} ${a.n}`).join(", ") || "none"} (kept as they are)`);
    console.log(`  payroll export rows: ${exp.n}${exp.n ? `, generated ${at(exp.generatedAt)} (kept; rebuilt when processed again)` : ""}`);
    if (bornProcessed) console.log("  → looks born \"processed\" by the generator (no approvals, never changed since creation).");

    if (p.status === "open") console.log("  already open, skipped.");
    else {
      if (p.status === "locked") console.log("  LOCKED, not processed: the cutoff page can reopen it too.");
      toReopen.push(p);
    }
  }

  if (!toReopen.length) return console.log("\nNothing to reopen.");
  if (!APPLY) return console.log(`\nDry run only. Rerun with --apply to set ${toReopen.length} cutoff(s) to "open".`);
  if (fs.existsSync(BACKUP)) return console.log(`\nBackup ${BACKUP} already exists. Refusing to overwrite it.`);

  fs.writeFileSync(
    BACKUP,
    JSON.stringify(
      {
        writtenAt: new Date().toISOString(),
        periods: toReopen.map((p) => ({ id: p.id, department: nameOf(p), oldStatus: p.status, oldUpdatedAt: p.updatedAt })),
      },
      null,
      2
    )
  );

  const done = [];
  const skipped = [];
  for (const p of toReopen) {
    const n = await prisma.$executeRaw`
      UPDATE "CutoffPeriod" SET "status" = 'open', "updatedAt" = NOW()
      WHERE "id" = ${p.id} AND "companyId" = ${COMPANY_ID} AND "status" = ${p.status}`;
    (n ? done : skipped).push(p);
    console.log(n ? `Reopened ${nameOf(p)}: "${p.status}" → "open".` : `Skipped ${nameOf(p)}: status changed since the check.`);
  }
  if (!done.length) {
    fs.unlinkSync(BACKUP);
    return console.log("\nNothing changed; backup removed. Run the dry run again.");
  }
  if (skipped.length) {
    const b = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
    b.periods = b.periods.filter((x) => done.some((p) => p.id === x.id));
    fs.writeFileSync(BACKUP, JSON.stringify(b, null, 2));
  }
  console.log(`\n${done.length} cutoff(s) reopened. Backup: ${BACKUP}. Undo with --revert.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
