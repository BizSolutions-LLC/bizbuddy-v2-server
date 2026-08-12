// src/services/Payroll/payrollExportService.js
//
// BB-066: called on every cutoff-period lock (first-time or re-lock).
// Recomputes the locking department's Regular/OT/Driver/Training/PTO summary
// and folds it into the single, take-latest PayrollExportBatch JSON for the
// whole companyId+periodStart+periodEnd — one row per period, always the
// latest merge across every department that has locked so far. Unlocking a
// department does nothing here; its last-computed slice just sits stale in
// the payload until that department locks again.
//
// PayrollExport / PayrollExportBatch are raw-SQL tables (see
// scripts/create-payroll-archive-tables.sql +
// scripts/add-payroll-export-department-and-batch-unique.sql). They are now
// modeled in schema.prisma too, but this file still goes through
// $queryRaw/$executeRaw rather than the typed client, same convention as the
// one-time archive script this was ported from
// (scripts/archive-and-export-payroll-2026-07-08-to-21.js).

const { prisma } = require("@config/connection");

const DRIVER_SEGMENT_TYPES = ["driver_am", "driver_pm"];
const DRIVER_PUNCH_TYPES   = ["DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];

function n(v) {
  return v == null ? 0 : parseFloat(v.toString());
}

function toDateStr(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

/**
 * @param {object} cutoffPeriod - { id, companyId, departmentId, periodStart, periodEnd }
 * @returns {Promise<{ employeeCount: number }>}
 */
async function generatePayrollExportForCutoffPeriod(cutoffPeriod) {
  const { id: cutoffPeriodId, companyId, departmentId } = cutoffPeriod;
  const periodStartStr = toDateStr(cutoffPeriod.periodStart);
  const periodEndStr   = toDateStr(cutoffPeriod.periodEnd);

  console.log(`[BB-066] generatePayrollExportForCutoffPeriod start — cutoffPeriodId=${cutoffPeriodId} companyId=${companyId} departmentId=${departmentId ?? "null"} period=${periodStartStr}..${periodEndStr}`);

  // ── 1. Approved punches for this exact cutoff period — already scoped to
  // this department via cutoffPeriodId, no date-range/company guessing needed ──
  const approvals = await prisma.timeLogApproval.findMany({
    where: { cutoffPeriodId, status: "approved" },
    include: { timeLog: { include: { user: { include: { profile: true } } } } },
  });

  // ── 2. Approved OT blocks for this exact cutoff period ──
  const otBlocks = await prisma.cutoffOtBlock.findMany({
    where: { cutoffPeriodId, status: "approved" },
    include: { user: true },
  });

  // ── 3. Paid LeaveDay rows in range — leave has no cutoffPeriodId, so this
  // one still needs department + date-range, same pattern as getCutoffApprovals ──
  const leaveDays = await prisma.leaveDay.findMany({
    where: {
      date:   { gte: cutoffPeriod.periodStart, lte: cutoffPeriod.periodEnd },
      isPaid: true,
      leave: {
        status: "approved",
        User: {
          companyId,
          ...(departmentId ? { departmentId } : {}),
        },
      },
    },
    include: { leave: { include: { User: { include: { profile: true } } } } },
  });

  console.log(`[BB-066] source rows found — approvals=${approvals.length} otBlocks=${otBlocks.length} leaveDays=${leaveDays.length}`);

  // ── 4. Per-employee aggregation — same classification as the original
  // one-time archive script ──
  const byUser = new Map();
  function getBucket(user) {
    if (!byUser.has(user.id)) {
      const profile = user.profile;
      byUser.set(user.id, {
        userId:       user.id,
        employeeId:   user.employeeId || null,
        employeeName: profile ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim() : user.email,
        regular: 0, ot: 0, driver: 0, training: 0, pto: 0,
      });
    }
    return byUser.get(user.id);
  }

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
      }
    }
  }

  for (const ob of otBlocks) {
    getBucket(ob.user).ot += n(ob.otHours);
  }

  for (const ld of leaveDays) {
    getBucket(ld.leave.User).pto += n(ld.hours);
  }

  // ── 5. Replace only this department's PayrollExport rows for the period —
  // "IS NOT DISTINCT FROM" so a NULL departmentId (company-wide period)
  // matches other NULLs correctly, unlike "=" ──
  await prisma.$executeRaw`
    DELETE FROM "PayrollExport"
    WHERE "companyId" = ${companyId}
      AND "periodStart" = ${periodStartStr}::date
      AND "periodEnd" = ${periodEndStr}::date
      AND "departmentId" IS NOT DISTINCT FROM ${departmentId}
  `;

  for (const b of byUser.values()) {
    await prisma.$executeRaw`
      INSERT INTO "PayrollExport" (
        "periodStart", "periodEnd", "companyId", "departmentId", "userId", "employeeId", "employeeName",
        "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
      ) VALUES (
        ${periodStartStr}::date, ${periodEndStr}::date, ${companyId}, ${departmentId}, ${b.userId}, ${b.employeeId}, ${b.employeeName},
        ${b.regular.toFixed(2)}::numeric, ${b.ot.toFixed(2)}::numeric, ${b.driver.toFixed(2)}::numeric,
        ${b.training.toFixed(2)}::numeric, ${b.pto.toFixed(2)}::numeric
      )
    `;
  }

  // ── 6. Reassemble the full company+period JSON from every department's
  // current PayrollExport rows — not just the one that just locked ──
  const allRows = await prisma.$queryRaw`
    SELECT "userId", "employeeId", "employeeName", "regularHours", "otHours", "driverHours", "trainingHours", "ptoHours"
    FROM "PayrollExport"
    WHERE "companyId" = ${companyId}
      AND "periodStart" = ${periodStartStr}::date
      AND "periodEnd" = ${periodEndStr}::date
  `;

  const employees = allRows.map((r) => ({
    EmployeeName:  r.employeeName,
    EmployeeID:    r.employeeId || null,
    UserID:        r.userId,
    RegularHours:  n(r.regularHours),
    OTHours:       n(r.otHours),
    DriverHours:   n(r.driverHours),
    TrainingHours: n(r.trainingHours),
    PTO:           n(r.ptoHours),
  }));

  const fullPayload = {
    companyId,
    periodStart: periodStartStr,
    periodEnd:   periodEndStr,
    generatedAt: new Date().toISOString(),
    employees,
  };

  // ── 7. Upsert the single take-latest PayrollExportBatch row for this period ──
  await prisma.$executeRaw`
    INSERT INTO "PayrollExportBatch" ("companyId", "periodStart", "periodEnd", "employeeCount", "payload")
    VALUES (${companyId}, ${periodStartStr}::date, ${periodEndStr}::date, ${employees.length}::int, ${JSON.stringify(fullPayload)}::jsonb)
    ON CONFLICT ("companyId", "periodStart", "periodEnd")
    DO UPDATE SET "employeeCount" = EXCLUDED."employeeCount", "payload" = EXCLUDED."payload", "generatedAt" = now()
  `;

  console.log(`[BB-066] done — wrote ${byUser.size} PayrollExport row(s) + upserted PayrollExportBatch for companyId=${companyId} period=${periodStartStr}..${periodEndStr}`);

  return { employeeCount: byUser.size };
}

module.exports = { generatePayrollExportForCutoffPeriod };
