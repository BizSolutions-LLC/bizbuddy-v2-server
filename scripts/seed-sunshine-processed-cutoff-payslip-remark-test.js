// scripts/seed-sunshine-processed-cutoff-payslip-remark-test.js
//
// Test helper for payslip REMARKS (Sunshine Learning only):
//   1) Create/reuse a company-wide CutoffPeriod marked processed
//   2) Upsert PayrollExport + PayrollExportBatch so Employee Sheet can Load Hours
//
// Then in the app (you do this part):
//   Payroll → Employee Sheet → select this cutoff → Load Hours → Compute
//   → Process Payroll Report → Disbursement → Mark paid (one employee)
//   → enter Remarks in the dialog → download / open payslip on mobile
//
// Does NOT invent punches via the normal finalize path, does NOT create a
// DisbursementBatch or PayrollRun, and does NOT send CUTOFF_PROCESSED emails.
//
// DRY_RUN=true  (default) → prints plan, writes nothing
// DRY_RUN=false → writes cutoff + export rows
//
// Optional env:
//   COMPANY_ID      skip name lookup (must still be Sunshine Learning)
//   PERIOD_START    default 2026-10-29
//   PERIOD_END      default 2026-11-11
//   PAYMENT_DATE    default 2026-11-13
//
// Usage (from bizbuddy-server):
//   node scripts/seed-sunshine-processed-cutoff-payslip-remark-test.js
//   DRY_RUN=false node scripts/seed-sunshine-processed-cutoff-payslip-remark-test.js
//
// If Employee Sheet says the period is already saved/locked, clear the old run first:
//   DRY_RUN=false PERIOD_START=2026-10-29 PERIOD_END=2026-11-11 \
//     node scripts/delete-sunshine-payroll-run-2026-08-27-to-09-09.js
//   (that delete script accepts PERIOD_START / PERIOD_END via env — confirm before run)

require("module-alias/register");
const { randomUUID } = require("crypto");
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "false";

const PERIOD_START = process.env.PERIOD_START || "2026-10-29";
const PERIOD_END = process.env.PERIOD_END || "2026-11-11";
const PAYMENT_DATE = process.env.PAYMENT_DATE || "2026-11-13";

const REGULAR_HOURS = 70;
const DRIVER_HOURS = 10;

function n(value) {
  return value == null ? 0 : parseFloat(value.toString());
}

function dateKey(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

function employeeName(user) {
  const profile = user.profile;
  const name = profile
    ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
    : "";
  return name || user.email;
}

function isSunshineLearning(name) {
  return /sunshine\s+learning/i.test(String(name || ""));
}

async function resolveCompany() {
  if (process.env.COMPANY_ID) {
    const company = await prisma.company.findUnique({
      where: { id: process.env.COMPANY_ID },
      select: { id: true, name: true, timeZone: true },
    });
    if (!company) {
      console.log(`Company ${process.env.COMPANY_ID} not found.`);
      return null;
    }
    if (!isSunshineLearning(company.name)) {
      console.log(
        `Refusing COMPANY_ID=${company.id} (${company.name}) — this script only writes Sunshine Learning.`
      );
      return null;
    }
    return company;
  }

  const matches = await prisma.company.findMany({
    where: { name: { contains: "Sunshine Learning", mode: "insensitive" } },
    select: { id: true, name: true, timeZone: true },
    orderBy: { name: "asc" },
  });

  const sunshine = matches.filter((c) => isSunshineLearning(c.name));

  if (sunshine.length === 0) {
    console.log('No company named "Sunshine Learning". Aborting.');
    return null;
  }

  if (sunshine.length > 1) {
    console.log('Multiple companies named "Sunshine Learning". Re-run with COMPANY_ID=...');
    for (const c of sunshine) {
      console.log(`  ${c.id}  ${c.name}`);
    }
    return null;
  }

  return sunshine[0];
}

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Seed processed cutoff (payslip remark test) — Sunshine Learning`);
  console.log(`  DRY_RUN=${DRY_RUN}`);
  console.log(`${"=".repeat(70)}\n`);

  const company = await resolveCompany();
  if (!company) return;

  const tz = company.timeZone || "America/Los_Angeles";
  const periodStart = moment.tz(PERIOD_START, tz).startOf("day").toDate();
  const periodEnd = moment.tz(PERIOD_END, tz).startOf("day").toDate();
  const paymentDate = moment.tz(PAYMENT_DATE, tz).startOf("day").toDate();

  console.log(`Company: ${company.name} (${company.id})`);
  console.log(`Timezone: ${tz}`);
  console.log(`Period: ${PERIOD_START} → ${PERIOD_END}  paymentDate=${PAYMENT_DATE}\n`);

  const creator = await prisma.user.findFirst({
    where: {
      companyId: company.id,
      status: "active",
      role: { in: ["admin", "superadmin", "supervisor"] },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, role: true },
  });

  if (!creator) {
    console.log("No active admin/superadmin/supervisor at this company. Aborting.");
    return;
  }

  console.log(`createdBy: ${creator.email} (${creator.role}, ${creator.id})\n`);

  const candidates = await prisma.cutoffPeriod.findMany({
    where: { companyId: company.id, departmentId: null },
    select: {
      id: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      paymentDate: true,
    },
  });

  const existing = candidates.find(
    (p) => dateKey(p.periodStart) === PERIOD_START && dateKey(p.periodEnd) === PERIOD_END
  );

  const users = await prisma.user.findMany({
    where: { companyId: company.id, status: "active" },
    select: {
      id: true,
      email: true,
      employeeId: true,
      role: true,
      profile: { select: { firstName: true, lastName: true } },
      payrollDetails: { select: { payRate: true, driverPayRate: true } },
    },
    orderBy: { email: "asc" },
  });

  const anyoneHasDriverRate = users.some((u) => n(u.payrollDetails?.driverPayRate) > 0);

  const exportRows = users.map((u) => {
    const payRate = n(u.payrollDetails?.payRate);
    const driverPayRate = n(u.payrollDetails?.driverPayRate);
    const driverHours = anyoneHasDriverRate ? (driverPayRate > 0 ? DRIVER_HOURS : 0) : DRIVER_HOURS;
    return {
      userId: u.id,
      email: u.email,
      employeeId: u.employeeId || null,
      employeeName: employeeName(u),
      payRate,
      driverPayRate,
      regularHours: REGULAR_HOURS,
      otHours: 0,
      driverHours,
      trainingHours: 0,
      ptoHours: 0,
    };
  });

  console.log(`Active employees: ${exportRows.length}`);
  for (const row of exportRows.slice(0, 12)) {
    console.log(
      `  ${row.employeeName}  regular=${row.regularHours}  driver=${row.driverHours}  payRate=${row.payRate || "—"}`
    );
  }
  if (exportRows.length > 12) {
    console.log(`  … +${exportRows.length - 12} more`);
  }
  console.log("");

  if (existing) {
    console.log(
      `Reuse cutoff ${existing.id} (status=${existing.status}) and set status=processed.`
    );
  } else {
    console.log("Create new company-wide cutoff (departmentId=null), status=processed.");
  }

  console.log("\nAfter apply, test remarks with:");
  console.log("  1. Employee Sheet → this cutoff → Load Hours → Compute → Process");
  console.log("  2. Disbursement → Mark paid on ONE unpaid employee");
  console.log("  3. Type Remarks in the dialog → attach proof → Mark paid");
  console.log("  4. Open/download payslip (web or mobile) — look for REMARKS block");
  console.log("  Note: already-Paid rows cannot get a new remark; use an unpaid person.\n");

  if (DRY_RUN) {
    console.log("Dry run — nothing written. Re-run with DRY_RUN=false to apply.\n");
    return;
  }

  let cutoffId = existing?.id;
  if (existing) {
    await prisma.cutoffPeriod.update({
      where: { id: existing.id },
      data: { status: "processed", paymentDate },
    });
  } else {
    cutoffId = randomUUID();
    await prisma.cutoffPeriod.create({
      data: {
        id: cutoffId,
        companyId: company.id,
        departmentId: null,
        periodStart,
        periodEnd,
        paymentDate,
        frequency: "bi-weekly",
        status: "processed",
        createdBy: creator.id,
        isAutoGenerated: false,
      },
    });
  }

  await prisma.$executeRaw`
    DELETE FROM "PayrollExport"
    WHERE "companyId" = ${company.id}
      AND "periodStart" = ${PERIOD_START}::date
      AND "periodEnd" = ${PERIOD_END}::date
      AND "departmentId" IS NOT DISTINCT FROM ${null}
  `;

  for (const row of exportRows) {
    await prisma.$executeRaw`
      INSERT INTO "PayrollExport" (
        "periodStart", "periodEnd", "companyId", "departmentId", "userId", "employeeId", "employeeName",
        "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
      ) VALUES (
        ${PERIOD_START}::date, ${PERIOD_END}::date, ${company.id}, ${null}, ${row.userId}, ${row.employeeId}, ${row.employeeName},
        ${row.regularHours.toFixed(2)}::numeric, ${row.otHours.toFixed(2)}::numeric, ${row.driverHours.toFixed(2)}::numeric,
        ${row.trainingHours.toFixed(2)}::numeric, ${row.ptoHours.toFixed(2)}::numeric
      )
    `;
  }

  const employees = exportRows.map((row) => ({
    EmployeeName: row.employeeName,
    EmployeeID: row.employeeId,
    UserID: row.userId,
    RegularHours: row.regularHours,
    OTHours: row.otHours,
    DriverHours: row.driverHours,
    TrainingHours: row.trainingHours,
    PTO: row.ptoHours,
  }));

  const fullPayload = {
    companyId: company.id,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    generatedAt: new Date().toISOString(),
    employees,
  };

  await prisma.$executeRaw`
    INSERT INTO "PayrollExportBatch" ("companyId", "periodStart", "periodEnd", "employeeCount", "payload")
    VALUES (${company.id}, ${PERIOD_START}::date, ${PERIOD_END}::date, ${employees.length}::int, ${JSON.stringify(fullPayload)}::jsonb)
    ON CONFLICT ("companyId", "periodStart", "periodEnd")
    DO UPDATE SET "employeeCount" = EXCLUDED."employeeCount", "payload" = EXCLUDED."payload", "generatedAt" = now()
  `;

  console.log(`Wrote cutoff ${cutoffId} (processed).`);
  console.log(
    `Upserted PayrollExportBatch + ${exportRows.length} PayrollExport row(s) for ${PERIOD_START}..${PERIOD_END}.`
  );
  console.log("\nDone. Use Employee Sheet → this cutoff → Load Hours.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
