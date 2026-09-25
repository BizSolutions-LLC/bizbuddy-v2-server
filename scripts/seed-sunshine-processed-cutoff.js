// scripts/seed-sunshine-processed-cutoff.js
//
// Test helper: find Sunshine Learning, create (or reuse) a company-wide
// CutoffPeriod marked processed, and upsert a sample PayrollExportBatch so
// Payroll → Employee Sheet can Load Hours → Compute → Save → Print check.
//
// Does NOT go through PATCH /cutoff-periods/:id/status, so it will not send
// CUTOFF_PROCESSED notifications. Does not invent punches or set driverPayRate.
//
// DRY_RUN=true  (default) → prints what it would write, writes nothing
// DRY_RUN=false → writes the cutoff + PayrollExport / PayrollExportBatch rows
//
// Optional env:
//   COMPANY_ID      skip name lookup
//   PERIOD_START    default 2026-08-27
//   PERIOD_END      default 2026-09-09
//   PAYMENT_DATE    default 2026-09-11
//
// Usage:
//   node scripts/seed-sunshine-processed-cutoff.js
//   DRY_RUN=false node scripts/seed-sunshine-processed-cutoff.js

require("module-alias/register");
const { randomUUID } = require("crypto");
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "false";

const PERIOD_START = process.env.PERIOD_START || "2026-08-27";
const PERIOD_END = process.env.PERIOD_END || "2026-09-09";
const PAYMENT_DATE = process.env.PAYMENT_DATE || "2026-09-11";

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
  console.log(`  Seed processed cutoff — Sunshine Learning  [DRY_RUN=${DRY_RUN}]`);
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
  if (!anyoneHasDriverRate) {
    console.log(
      "WARNING: no employee has driverPayRate > 0. Seeding 10 DriverHours for every active employee anyway."
    );
    console.log(
      "Compute will only turn those hours into Driver/Aide Pay after you set Driver Rate on Payroll → Employee.\n"
    );
  }

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
  for (const row of exportRows) {
    const missing = [];
    if (!(row.payRate > 0)) missing.push("payRate");
    if (!(row.driverPayRate > 0) && row.driverHours > 0) missing.push("driverPayRate");
    console.log(
      `  ${row.employeeName}  regular=${row.regularHours}  driver=${row.driverHours}` +
        (missing.length ? `  MISSING ${missing.join(", ")}` : "")
    );
  }
  console.log("");

  if (existing) {
    console.log(
      `Reuse cutoff ${existing.id} (status=${existing.status}) and set status=processed.`
    );
  } else {
    console.log("Create new company-wide cutoff (departmentId=null), status=processed.");
  }

  if (DRY_RUN) {
    console.log("\nDry run — nothing written. Re-run with DRY_RUN=false to apply.\n");
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
  console.log("\nIn the app: Payroll → Employee Sheet → select this cutoff → Load Hours.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
