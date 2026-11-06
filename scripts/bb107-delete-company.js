// scripts/bb107-delete-company.js
//
// BB-107 — permanently deletes the "test" company and everything that belongs to it.
// Locked to that one company (id AND name must match); it refuses anything else.
//
// Dry run (default): counts every linked record, and lists anything outside the
// company that points at its users. Nothing is written.
//
// --apply:
//   1. exports every row it will delete to scripts/backup-bb107-delete-<id>-<timestamp>.json
//   2. in ONE transaction: clears references other records hold to its users
//      (approver, supervisor, editor …), deletes the records the database won't
//      delete on its own (shifts, locations, user shifts, activity, OT blocks,
//      cutoff periods, disbursements, payroll exports), then the users and the
//      company — everything else goes with them (time logs, leave, payroll …).
//      If any step fails, the whole transaction rolls back and nothing is deleted.
//
// Request logs are kept (their user/company link is set empty by the database).
//
// Usage:
//   node scripts/bb107-delete-company.js            # dry run
//   node scripts/bb107-delete-company.js --apply

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const COMPANY_ID = "cmuqfhyq70003v7obaiilslzx";
const COMPANY_NAME = "test";
const APPLY = process.argv.includes("--apply");

// Everything owned by the company or its users: counted in the dry run, exported on --apply.
const byCompany = (C) => ({ companyId: C });
const byUsers = (_C, U) => ({ userId: { in: U } });
const OWNED = [
  ["company", (C) => ({ id: C })],
  ["user", byCompany],
  ["userProfile", byUsers],
  ["employmentDetail", byUsers],
  ["department", byCompany],
  ["location", byCompany],
  ["locationRestriction", (C, U) => ({ OR: [byUsers(C, U), { location: { companyId: C } }] })],
  ["shift", byCompany],
  ["shiftSchedule", byCompany],
  ["userShift", (C, U) => ({ OR: [byUsers(C, U), { shift: { companyId: C } }] })],
  ["timeLog", byUsers],
  ["requestedTimeLog", byUsers],
  ["userActivity", byUsers],
  ["userPresence", byUsers],
  ["liveUser", byCompany],
  ["leavePolicy", byCompany],
  ["leavePolicyAssignment", byUsers],
  ["leave", byUsers],
  ["leaveBalance", byUsers],
  ["leaveTransaction", byUsers],
  ["leaveCredit", byUsers],
  ["overtime", byCompany],
  ["holiday", byCompany],
  ["cutoffPeriod", byCompany],
  ["cutoffOtBlock", byUsers],
  ["cutoffFixedHours", byUsers],
  ["companyCutoffSettings", byCompany],
  ["departmentCutoffSettings", byCompany],
  ["paySchedule", byCompany],
  ["payrollRun", byCompany],
  ["payrollEntry", byUsers],
  ["payrollConfiguration", byCompany],
  ["payrollExport", byCompany],
  ["payrollExportBatch", byCompany],
  ["employeePayrollDetails", byUsers],
  ["earningType", byCompany],
  ["deductionType", byCompany],
  ["federalTaxRate", byCompany],
  ["stateIncomeTaxRate", byCompany],
  ["tax", byCompany],
  ["userRate", byUsers],
  ["deduction", byUsers],
  ["payroll", byUsers],
  ["attendanceSummary", byUsers],
  ["disbursementBatch", byCompany],
  ["disbursementRecipient", (C, U) => ({ OR: [{ employeeId: { in: U } }, { batch: { companyId: C } }] })],
  ["subscription", byCompany],
  ["notificationLog", byCompany],
  ["emailNotificationLog", byCompany],
  ["feedback", byCompany],
  ["accountDeletionRequest", byCompany],
  ["otp", byUsers],
  ["passwordResetToken", byUsers],
];

// Optional references to these users held by other records — set empty first.
const USER_REFS = [
  ["accountDeletionRequest", "reviewedBy"],
  ["employmentDetail", "supervisorId"],
  ["department", "supervisorId"],
  ["leaveTransaction", "performedById"],
  ["cutoffOtBlock", "approvedBy"],
  ["cutoffFixedHours", "editedBy"],
  ["timeLogApproval", "approvedBy"],
  ["requestedTimeLog", "approverId"],
  ["requestedTimeLog", "createdByUserId"],
  ["contestTimeLog", "approverId"],
  ["leave", "approverId"],
  ["leave", "escalatedByUserId"],
  ["leave", "decidedByUserId"],
  ["overtime", "approverId"],
  ["disbursementBatch", "approvedById"],
  ["disbursementBatch", "paymentMarkedById"],
  ["disbursementRecipient", "paymentMarkedById"],
  ["disbursementAuditEvent", "actorUserId"],
];

// Required references to these users from OTHER companies would block the delete.
const BLOCKERS = [
  ["cutoffPeriod", (C, U) => ({ createdBy: { in: U }, NOT: { companyId: C } }), "created a cutoff period in another company"],
  ["disbursementBatch", (C, U) => ({ createdById: { in: U }, NOT: { companyId: C } }), "created a disbursement in another company"],
];

async function count(db, model, where) {
  try {
    return await db[model].count({ where });
  } catch (err) {
    return `ERROR (${err.message.split("\n").pop().trim()})`;
  }
}

async function main() {
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID }, select: { id: true, name: true } });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found — already deleted?`);
  if (company.name !== COMPANY_NAME)
    throw new Error(`Company ${COMPANY_ID} is named "${company.name}", expected "${COMPANY_NAME}". Stopping.`);

  const C = COMPANY_ID;
  const users = await prisma.user.findMany({ where: { companyId: C }, select: { id: true, email: true, status: true, role: true } });
  const U = users.map((u) => u.id);

  console.log(`Delete "${company.name}" (${C}) — permanently.\n`);
  console.log(`Users (${users.length}):`);
  for (const u of users) console.log(`  ${String(u.email).padEnd(40)} ${String(u.role).padEnd(11)} ${u.status}`);

  console.log(`\nRecords that will be deleted:`);
  let problems = 0;
  for (const [model, where] of OWNED) {
    const n = await count(prisma, model, where(C, U));
    if (typeof n === "string") problems++;
    if (n !== 0) console.log(`  ${model.padEnd(26)} ${n}`);
  }

  console.log(`\nReferences elsewhere to these users that will be set empty:`);
  let refs = 0;
  for (const [model, field] of USER_REFS) {
    const n = await count(prisma, model, { [field]: { in: U } });
    if (typeof n === "string") problems++;
    if (n !== 0) {
      refs++;
      console.log(`  ${model}.${field}`.padEnd(46) + ` ${n}`);
    }
  }
  if (!refs) console.log("  none");

  const blockers = [];
  for (const [model, where, what] of BLOCKERS) {
    const n = await count(prisma, model, where(C, U));
    if (n !== 0) blockers.push(`  ${n} × a user of this company ${what}`);
  }
  const requestLogs = await count(prisma, "requestLog", { companyId: C });
  console.log(`\nKept: ${requestLogs} request log rows (company/user link set empty).`);

  if (problems) throw new Error(`\n${problems} count(s) failed above — tell Claude before applying.`);
  if (blockers.length) throw new Error(`\nCan't delete — records in other companies depend on these users:\n${blockers.join("\n")}`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  // 1. Export
  const backup = { exportedAt: new Date().toISOString(), companyId: C, rows: {} };
  for (const [model, where] of OWNED) backup.rows[model] = await prisma[model].findMany({ where: where(C, U) });
  const backupFile = path.join(__dirname, `backup-bb107-delete-${C}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nExported to ${backupFile}`);

  // 2. Delete, all or nothing
  await prisma.$transaction(
    async (tx) => {
      for (const [model, field] of USER_REFS) {
        await tx[model].updateMany({ where: { [field]: { in: U } }, data: { [field]: null } });
      }
      await tx.disbursementRecipient.deleteMany({ where: { OR: [{ employeeId: { in: U } }, { batch: { companyId: C } }] } });
      await tx.disbursementBatch.deleteMany({ where: { companyId: C } });
      await tx.userShift.deleteMany({ where: { OR: [{ userId: { in: U } }, { shift: { companyId: C } }] } });
      await tx.locationRestriction.deleteMany({ where: { OR: [{ userId: { in: U } }, { location: { companyId: C } }] } });
      await tx.userActivity.deleteMany({ where: { userId: { in: U } } });
      await tx.cutoffOtBlock.deleteMany({ where: { userId: { in: U } } });
      await tx.cutoffPeriod.deleteMany({ where: { companyId: C } });
      await tx.shift.deleteMany({ where: { companyId: C } });
      await tx.location.deleteMany({ where: { companyId: C } });
      await tx.payrollExport.deleteMany({ where: { companyId: C } });
      await tx.payrollExportBatch.deleteMany({ where: { companyId: C } });
      await tx.user.deleteMany({ where: { companyId: C } });
      await tx.company.delete({ where: { id: C } });
    },
    { timeout: 120000, maxWait: 10000 }
  );

  console.log(`Deleted "${company.name}" and ${users.length} users.`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
