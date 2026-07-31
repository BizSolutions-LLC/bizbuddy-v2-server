// scripts/archive-and-export-payroll-2026-07-08-to-21.js
//
// One-time: secures the approved punch + leave data underlying payroll for
// Jul 8, 2026 – Jul 21, 2026 (company cmnegwuxm0004rf7fzo6wjrw2) into new
// archive tables, then computes per-employee Regular/OT/Driver/Training/PTO
// totals for the payroll integration handoff.
//
// Run scripts/create-payroll-archive-tables.sql first — this script only
// INSERTs into the tables it creates (CutoffPunchArchive, LeaveDayArchive,
// PayrollExport, PayrollExportBatch). It never UPDATEs or DELETEs anything,
// and never writes to any existing table — TimeLog, TimeLogApproval,
// CutoffOtBlock, Leave, LeaveDay, User are read-only here.
//
// PayrollExportBatch holds the exact JSON payload (as JSONB) that also gets
// written to the output file — the source of truth for fetching this
// period's export later without reconstructing it from PayrollExport's columns.
//
// Regular Hours   = REGULAR punches + the "regular" segment of a DRIVER_AIDE
//                   3-segment day
// Driver Hours    = DRIVER_AIDE_AM / DRIVER_AIDE_PM punches + the driver_am /
//                   driver_pm segments of a DRIVER_AIDE 3-segment day
// Training Hours  = TRAINING punches
// OT Hours        = approved CutoffOtBlock rows in range (works for both
//                   daily-basis, many-rows-per-employee and cutoff-basis,
//                   one-row-per-employee — date-range filtering covers both)
// PTO             = all paid LeaveDay hours in range, any leave type merged
//                   into one figure (per-type breakdown printed for sanity
//                   checking, not filtered out)
//
// DRY_RUN=true  (default) → prints everything it would archive/export, writes nothing
// DRY_RUN=false → writes the archive rows + PayrollExport rows + JSON file

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const moment           = require("moment-timezone");
const fs               = require("fs");
const path             = require("path");

const prisma  = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN !== "false";

const COMPANY_ID   = "cmnegwuxm0004rf7fzo6wjrw2";
const PERIOD_START = "2026-07-08";
const PERIOD_END   = "2026-07-21";

const DRIVER_SEGMENT_TYPES = ["driver_am", "driver_pm"];
const DRIVER_PUNCH_TYPES   = ["DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];

function n(v) {
  return v == null ? 0 : parseFloat(v.toString());
}

async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Payroll archive + export — ${PERIOD_START} to ${PERIOD_END}  [DRY_RUN=${DRY_RUN}]`);
  console.log(`${"═".repeat(70)}\n`);

  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { id: true, name: true, timeZone: true, otBasis: true },
  });
  if (!company) {
    console.log(`❌  Company ${COMPANY_ID} not found.`);
    return;
  }
  const tz         = company.timeZone || "America/Los_Angeles";
  const periodStart = moment.tz(PERIOD_START, tz).startOf("day");
  const periodEnd   = moment.tz(PERIOD_END, tz).endOf("day");
  console.log(`Company: ${company.name} (${company.id})`);
  console.log(`Timezone: ${tz}  |  OT basis: ${company.otBasis || "daily"}`);
  console.log(`Period (company-tz): ${periodStart.format()} → ${periodEnd.format()}\n`);

  // ── 1. Approved punches in range, this company only ──────────────────────
  const approvals = await prisma.timeLogApproval.findMany({
    where: {
      status:  "approved",
      timeLog: {
        timeIn: { gte: periodStart.toDate(), lte: periodEnd.toDate() },
        user:   { companyId: COMPANY_ID },
      },
    },
    include: {
      timeLog: { include: { user: { include: { profile: true } } } },
    },
  });
  console.log(`Approved punch records found: ${approvals.length}`);

  // ── 2. LeaveDay rows (paid + unpaid, for full audit coverage) in range ───
  const leaveDays = await prisma.leaveDay.findMany({
    where: {
      date:  { gte: periodStart.toDate(), lte: periodEnd.toDate() },
      leave: { status: "approved", User: { companyId: COMPANY_ID } },
    },
    include: {
      leave: { include: { policy: true, User: { include: { profile: true } } } },
    },
  });
  console.log(`Approved LeaveDay rows found:  ${leaveDays.length}`);

  // ── 3. Approved OT blocks in range, this company only ────────────────────
  const otBlocks = await prisma.cutoffOtBlock.findMany({
    where: {
      status: "approved",
      date:   { gte: periodStart.toDate(), lte: periodEnd.toDate() },
      user:   { companyId: COMPANY_ID },
    },
    include: { user: true },
  });
  console.log(`Approved OT blocks found:      ${otBlocks.length}\n`);

  if (approvals.length === 0 && leaveDays.length === 0 && otBlocks.length === 0) {
    console.log("Nothing found for this company/period — check COMPANY_ID and dates before proceeding.\n");
    return;
  }

  // ── 4. Per-employee aggregation ───────────────────────────────────────────
  const byUser = new Map();

  function getBucket(user) {
    if (!byUser.has(user.id)) {
      const profile = user.profile;
      byUser.set(user.id, {
        userId:       user.id,
        employeeId:   user.employeeId || null,
        employeeName: profile ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim() : user.email,
        email:        user.email,
        regular: 0, ot: 0, driver: 0, training: 0, pto: 0,
        leaveTypeBreakdown: {},
      });
    }
    return byUser.get(user.id);
  }

  let unclassifiedHours = 0;
  for (const a of approvals) {
    const tl   = a.timeLog;
    const user = tl.user;
    const b    = getBucket(user);
    const hrs  = n(a.actualHours);

    if (tl.punchType === "REGULAR") {
      b.regular += hrs;
    } else if (tl.punchType === "TRAINING") {
      b.training += hrs;
    } else if (DRIVER_PUNCH_TYPES.includes(tl.punchType)) {
      b.driver += hrs;
    } else if (tl.punchType === "DRIVER_AIDE") {
      if (a.segmentType === "regular") {
        b.regular += hrs;
      } else if (DRIVER_SEGMENT_TYPES.includes(a.segmentType)) {
        b.driver += hrs;
      } else {
        unclassifiedHours += hrs;
        console.warn(`⚠️  Unclassified DRIVER_AIDE segment "${a.segmentType}" on approval ${a.id} (${hrs}h) — not counted in any category.`);
      }
    } else {
      unclassifiedHours += hrs;
      console.warn(`⚠️  Unrecognized punchType "${tl.punchType}" on approval ${a.id} (${hrs}h) — not counted in any category.`);
    }
  }

  for (const ob of otBlocks) {
    const b = getBucket(ob.user);
    b.ot += n(ob.otHours);
  }

  for (const ld of leaveDays) {
    const leave = ld.leave;
    const user  = leave.User;
    const b     = getBucket(user);
    const leaveTypeName = leave.policy?.leaveType || leave.leaveType || "Unknown";
    if (ld.isPaid) {
      b.pto += n(ld.hours);
      b.leaveTypeBreakdown[leaveTypeName] = (b.leaveTypeBreakdown[leaveTypeName] || 0) + n(ld.hours);
    }
  }

  if (unclassifiedHours > 0) {
    console.log(`\n⚠️  ${unclassifiedHours.toFixed(2)}h total could not be classified into Regular/Driver/Training — see warnings above. Review before proceeding.\n`);
  }

  // ── 5. Print summary + PTO leave-type breakdown for sanity-checking ──────
  console.log("Per-employee totals (Regular / OT / Driver / Training / PTO):");
  for (const b of byUser.values()) {
    const breakdown = Object.keys(b.leaveTypeBreakdown).length
      ? `  [PTO breakdown: ${Object.entries(b.leaveTypeBreakdown).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(", ")}]`
      : "";
    console.log(
      `  ${b.employeeName.padEnd(28)} EmpID=${(b.employeeId || "—").padEnd(10)} ` +
      `R=${b.regular.toFixed(2)} OT=${b.ot.toFixed(2)} Drv=${b.driver.toFixed(2)} ` +
      `Trn=${b.training.toFixed(2)} PTO=${b.pto.toFixed(2)}${breakdown}`
    );
  }
  console.log("");

  if (DRY_RUN) {
    console.log("DRY_RUN=true — nothing written. Re-run with DRY_RUN=false to archive + export.\n");
    return;
  }

  // ── 6. Clear any prior run's rows for this exact company+period first, so
  // re-running after a mid-script failure (or just re-generating) never
  // duplicates archive/export rows — scoped tightly to these 4 new tables
  // only, nothing else is touched.
  await prisma.$executeRaw`DELETE FROM "CutoffPunchArchive" WHERE "companyId" = ${COMPANY_ID} AND "periodStart" = ${PERIOD_START}::date AND "periodEnd" = ${PERIOD_END}::date`;
  await prisma.$executeRaw`DELETE FROM "LeaveDayArchive"    WHERE "companyId" = ${COMPANY_ID} AND "periodStart" = ${PERIOD_START}::date AND "periodEnd" = ${PERIOD_END}::date`;
  await prisma.$executeRaw`DELETE FROM "PayrollExport"      WHERE "companyId" = ${COMPANY_ID} AND "periodStart" = ${PERIOD_START}::date AND "periodEnd" = ${PERIOD_END}::date`;
  await prisma.$executeRaw`DELETE FROM "PayrollExportBatch" WHERE "companyId" = ${COMPANY_ID} AND "periodStart" = ${PERIOD_START}::date AND "periodEnd" = ${PERIOD_END}::date`;
  console.log("🧹  Cleared any prior rows for this company+period from all 4 tables (clean re-run).\n");

  // ── 7. Write archive rows ─────────────────────────────────────────────────
  for (const a of approvals) {
    const tl      = a.timeLog;
    const user    = tl.user;
    const profile = user.profile;
    await prisma.$executeRaw`
      INSERT INTO "CutoffPunchArchive" (
        "periodStart", "periodEnd", "companyId", "timeLogApprovalId", "timeLogId", "userId",
        "employeeId", "employeeEmail", "employeeFirstName", "employeeLastName",
        "punchType", "segmentType", "approvalStatus", "timeIn", "timeOut",
        "approvedClockIn", "approvedClockOut", "actualHours", "scheduledHours"
      ) VALUES (
        ${PERIOD_START}::date, ${PERIOD_END}::date, ${COMPANY_ID}, ${a.id}, ${tl.id}, ${user.id},
        ${user.employeeId}, ${user.email}, ${profile?.firstName || null}, ${profile?.lastName || null},
        ${tl.punchType}, ${a.segmentType}, ${a.status}, ${tl.timeIn}, ${tl.timeOut},
        ${a.approvedClockIn}, ${a.approvedClockOut}, ${a.actualHours}, ${a.scheduledHours}
      )
    `;
  }
  console.log(`✅  Archived ${approvals.length} punch record(s) into CutoffPunchArchive.`);

  for (const ld of leaveDays) {
    const leave = ld.leave;
    const user  = leave.User;
    const leaveTypeName = leave.policy?.leaveType || leave.leaveType || "Unknown";
    await prisma.$executeRaw`
      INSERT INTO "LeaveDayArchive" (
        "periodStart", "periodEnd", "companyId", "leaveDayId", "leaveId", "userId",
        "employeeId", "employeeEmail", "leaveType", "date", "isPaid", "hours", "leaveStatus"
      ) VALUES (
        ${PERIOD_START}::date, ${PERIOD_END}::date, ${COMPANY_ID}, ${ld.id}, ${leave.id}, ${user.id},
        ${user.employeeId}, ${user.email}, ${leaveTypeName}, ${ld.date}, ${ld.isPaid}, ${ld.hours}, ${leave.status}
      )
    `;
  }
  console.log(`✅  Archived ${leaveDays.length} leave-day record(s) into LeaveDayArchive.`);

  // ── 8. Write PayrollExport rows + build the JSON payload ─────────────────
  const payload = [];
  for (const b of byUser.values()) {
    await prisma.$executeRaw`
      INSERT INTO "PayrollExport" (
        "periodStart", "periodEnd", "companyId", "userId", "employeeId", "employeeName",
        "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
      ) VALUES (
        ${PERIOD_START}::date, ${PERIOD_END}::date, ${COMPANY_ID}, ${b.userId}, ${b.employeeId}, ${b.employeeName},
        ${b.regular.toFixed(2)}::numeric, ${b.ot.toFixed(2)}::numeric, ${b.driver.toFixed(2)}::numeric,
        ${b.training.toFixed(2)}::numeric, ${b.pto.toFixed(2)}::numeric
      )
    `;
    payload.push({
      EmployeeName:  b.employeeName,
      EmployeeID:    b.employeeId || null,
      UserID:        b.userId,
      RegularHours:  +b.regular.toFixed(2),
      OTHours:       +b.ot.toFixed(2),
      DriverHours:   +b.driver.toFixed(2),
      TrainingHours: +b.training.toFixed(2),
      PTO:           +b.pto.toFixed(2),
    });
  }
  console.log(`✅  Wrote ${byUser.size} employee row(s) into PayrollExport.`);

  const fullPayload = {
    companyId:   COMPANY_ID,
    periodStart: PERIOD_START,
    periodEnd:   PERIOD_END,
    generatedAt: new Date().toISOString(),
    employees:   payload,
  };

  // ── 9. Write the same JSON as one row in PayrollExportBatch — the "fetch
  // this period's export" source of truth going forward, no reconstruction
  // from PayrollExport's columns needed.
  await prisma.$executeRaw`
    INSERT INTO "PayrollExportBatch" (
      "companyId", "periodStart", "periodEnd", "employeeCount", "payload"
    ) VALUES (
      ${COMPANY_ID}, ${PERIOD_START}::date, ${PERIOD_END}::date, ${payload.length}::int, ${JSON.stringify(fullPayload)}::jsonb
    )
  `;
  console.log(`✅  Wrote 1 row into PayrollExportBatch (payload: ${payload.length} employees).`);

  const outDir  = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `payroll-export-${PERIOD_START}-to-${PERIOD_END}.json`);
  fs.writeFileSync(outFile, JSON.stringify(fullPayload, null, 2));
  console.log(`✅  Wrote JSON export to ${outFile}\n`);
}

main()
  .catch((e) => {
    console.error("❌  Script failed:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
