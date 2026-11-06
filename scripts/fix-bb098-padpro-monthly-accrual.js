// scripts/fix-bb098-padpro-monthly-accrual.js
//
// BB-098 — PadPro's leave credit setup was applied on 2026-10-21 with Grant
// Mode = Yearly lump sum and Regularization = Full. It should be Monthly
// accrual (40h / 12 per month) with Regularization = Catch up (6 × 3.33 = 20h
// on the regularization day). PadPro's FY2026 40h is already in the opening
// balances, so monthly accrual starts with January 2027.
//
// What --apply writes (one transaction):
//   - Company: leaveGrantMode = monthly_accrual, leaveRegularizationGrant = catch_up
//   - LeaveBalance: lastGrantPeriod "FY2026" → "2026-12" (marked as granted
//     through December 2026, so the first monthly accrual is January 2027)
// Nothing else changes: lots, Eduardo Aviso's FY2024 expiry, balances.
//
// DEPLOY FIRST: the server must have the runGrants change that treats a later
// lastGrantPeriod as already granted (periodCovered in leaveCreditService).
// On the old code the hourly worker would see "2026-12" ≠ "2026-10" and grant
// October's 3.33h to everyone at the next :15.
//
// Safety checks before --apply:
//   - setup applied, grant mode still yearly_lump
//   - no "accrual" ledger rows since setup (no grant has run)
//   - today (company timezone) is before 2027-01-01
//   - the backup file doesn't exist yet
//
// Backup: scripts/backup-bb098-padpro-monthly-accrual.json (old company
// settings + every changed balance's previous lastGrantPeriod).
//
// Usage:
//   node scripts/fix-bb098-padpro-monthly-accrual.js            # dry run
//   node scripts/fix-bb098-padpro-monthly-accrual.js --apply
//   node scripts/fix-bb098-padpro-monthly-accrual.js --revert   # restores from the backup

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
const FROM_PERIOD = "FY2026";
const TO_PERIOD = "2026-12";
const NEW_SETTINGS = { leaveGrantMode: "monthly_accrual", leaveRegularizationGrant: "catch_up" };
const BACKUP_FILE = path.join(__dirname, "backup-bb098-padpro-monthly-accrual.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

async function loadState() {
  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: {
      id: true, name: true, timeZone: true, leaveCreditsInitializedAt: true,
      leaveGrantEnabled: true, leaveExpirationEnabled: true,
      leaveGrantMode: true, leaveRegularizationGrant: true,
    },
  });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const policyIds = (await prisma.leavePolicy.findMany({ where: { companyId: COMPANY_ID }, select: { id: true } }))
    .map((p) => p.id);
  return { company, policyIds };
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup at ${BACKUP_FILE} — nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  const { company, policyIds } = await loadState();

  const accrualsSince = await prisma.leaveTransaction.count({
    where: { policyId: { in: policyIds }, type: "accrual", createdAt: { gte: new Date(backup.appliedAt) } },
  });
  if (accrualsSince > 0) {
    console.log(`REFUSING: ${accrualsSince} accrual ledger rows were written after the fix (${backup.appliedAt}).`);
    console.log("Reverting the settings now would leave those grants under the wrong mode — reverse them first.");
    return;
  }

  console.log(`Company: ${company.name} — now ${company.leaveGrantMode} / ${company.leaveRegularizationGrant}`);
  console.log(`Restoring ${backup.company.leaveGrantMode} / ${backup.company.leaveRegularizationGrant} and ${backup.balances.length} lastGrantPeriod values.`);

  await prisma.$transaction(async (tx) => {
    await tx.company.update({
      where: { id: COMPANY_ID },
      data:  {
        leaveGrantMode:           backup.company.leaveGrantMode,
        leaveRegularizationGrant: backup.company.leaveRegularizationGrant,
      },
    });
    for (const b of backup.balances) {
      await tx.leaveBalance.update({ where: { id: b.id }, data: { lastGrantPeriod: b.lastGrantPeriod } });
    }
  });
  console.log("Reverted. The backup file is left in place; rename it before running --apply again.");
}

async function main() {
  if (REVERT) return revert();

  const { company, policyIds } = await loadState();
  const tz = company.timeZone || "America/Los_Angeles";
  const today = moment.tz(tz).format("YYYY-MM-DD");

  console.log(`Company: ${company.name} (${COMPANY_ID})`);
  console.log(`  leaveCreditsInitializedAt: ${company.leaveCreditsInitializedAt?.toISOString() ?? "null"}`);
  console.log(`  leaveGrantEnabled: ${company.leaveGrantEnabled}   leaveExpirationEnabled: ${company.leaveExpirationEnabled}`);
  console.log(`  leaveGrantMode: ${company.leaveGrantMode} → ${NEW_SETTINGS.leaveGrantMode}`);
  console.log(`  leaveRegularizationGrant: ${company.leaveRegularizationGrant} → ${NEW_SETTINGS.leaveRegularizationGrant}`);
  console.log(`  today (${tz}): ${today}`);

  const problems = [];
  if (!company.leaveCreditsInitializedAt) problems.push("leave credit setup hasn't been applied");
  if (company.leaveGrantMode !== "yearly_lump") problems.push(`grant mode is already ${company.leaveGrantMode}`);
  if (today >= "2027-01-01") problems.push("it's already 2027 — the yearly FY2027 grant may have run; re-check first");
  if (company.leaveCreditsInitializedAt) {
    const accruals = await prisma.leaveTransaction.count({
      where: { policyId: { in: policyIds }, type: "accrual", createdAt: { gte: company.leaveCreditsInitializedAt } },
    });
    if (accruals > 0) problems.push(`${accruals} accrual ledger rows exist since setup — grants have run`);
  }

  const balances = await prisma.leaveBalance.findMany({
    where:  { policyId: { in: policyIds } },
    select: { id: true, userId: true, policyId: true, lastGrantPeriod: true },
  });
  const toChange = balances.filter((b) => b.lastGrantPeriod === FROM_PERIOD);
  const others = {};
  for (const b of balances.filter((x) => x.lastGrantPeriod !== FROM_PERIOD))
    others[b.lastGrantPeriod ?? "null"] = (others[b.lastGrantPeriod ?? "null"] || 0) + 1;

  console.log(`\nLeaveBalance rows: ${balances.length}`);
  console.log(`  lastGrantPeriod ${FROM_PERIOD} → ${TO_PERIOD}: ${toChange.length} rows`);
  for (const [k, v] of Object.entries(others)) console.log(`  left as is (${k}): ${v} rows`);
  if (Object.keys(others).length)
    console.log("  NOTE: rows left as is will get the next monthly accrual on the worker's next run.");

  if (problems.length) {
    console.log("\nREFUSING:");
    for (const p of problems) console.log(`  - ${p}`);
    return;
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply (after deploying the runGrants change).");
    return;
  }

  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`\nBackup already exists: ${BACKUP_FILE}. Refusing to overwrite it.`);
    return;
  }

  const appliedAt = new Date().toISOString();
  fs.writeFileSync(BACKUP_FILE, JSON.stringify({
    appliedAt,
    company: {
      leaveGrantMode:           company.leaveGrantMode,
      leaveRegularizationGrant: company.leaveRegularizationGrant,
    },
    balances: toChange,
  }, null, 2));
  console.log(`\nBackup written: ${BACKUP_FILE}`);

  await prisma.$transaction(async (tx) => {
    await tx.company.update({ where: { id: COMPANY_ID }, data: NEW_SETTINGS });
    const res = await tx.leaveBalance.updateMany({
      where: { id: { in: toChange.map((b) => b.id) }, lastGrantPeriod: FROM_PERIOD },
      data:  { lastGrantPeriod: TO_PERIOD },
    });
    console.log(`Updated company settings and ${res.count} LeaveBalance rows.`);
  });
  console.log(`Done. First monthly accrual: January 2027 (worker run after 2027-01-01 00:00 ${tz}).`);
}

main()
  .catch((err) => {
    console.error("Fix failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
