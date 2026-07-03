// scripts/verify-ot-formula-daynee.js
// Read-only diagnostic: compare old (Bug 6) vs new (TR-excluded) OT formula
// against Daynee Cuaresma's Jun 10–23 2026 cutoff period. Does not write anything.

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: {
      profile: {
        AND: [
          { firstName: { contains: "Daynee",   mode: "insensitive" } },
          { lastName:  { contains: "Cuaresma", mode: "insensitive" } },
        ],
      },
    },
    include: { profile: true },
  });

  if (!user) { console.log("❌ User not found."); return; }

  const candidates = await prisma.cutoffPeriod.findMany({
    where: {
      companyId:   user.companyId,
      periodStart: new Date("2026-06-10T00:00:00.000Z"),
      periodEnd:   new Date("2026-06-23T00:00:00.000Z"),
    },
  });

  let cutoffPeriod = null;
  for (const cp of candidates) {
    const count = await prisma.timeLogApproval.count({
      where: { cutoffPeriodId: cp.id, status: "approved", timeLog: { userId: user.id } },
    });
    if (count > 0) { cutoffPeriod = cp; break; }
  }

  if (!cutoffPeriod) { console.log("❌ Cutoff period not found."); return; }

  const company = await prisma.company.findUnique({
    where:  { id: user.companyId },
    select: { otBasis: true, cutoffOtThresholdHours: true },
  });

  const threshold = parseFloat(company.cutoffOtThresholdHours ?? 80);

  const approved = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId: cutoffPeriod.id,
      status:  "approved",
      timeLog: { userId: user.id },
    },
    select: {
      actualHours:      true,
      approvedClockIn:  true,
      approvedClockOut: true,
      timeLog: { select: { netWorkedHours: true, punchType: true, timeIn: true } },
    },
  });

  let oldTotal = 0;      // Bug 6 behavior: training included
  let newTotal = 0;      // superseding fix: training excluded
  let trainingHours = 0;

  for (const a of approved) {
    const hours = a.actualHours != null
      ? parseFloat(a.actualHours.toString())
      : a.approvedClockIn && a.approvedClockOut
        ? (new Date(a.approvedClockOut) - new Date(a.approvedClockIn)) / 3600000
        : parseFloat(a.timeLog?.netWorkedHours?.toString() ?? 0);

    oldTotal += hours;
    if (a.timeLog?.punchType === "TRAINING") {
      trainingHours += hours;
    } else {
      newTotal += hours;
    }
  }

  const oldOt = Math.max(0, oldTotal - threshold);
  const newOt = Math.max(0, newTotal - threshold);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`User               : ${user.profile?.firstName} ${user.profile?.lastName}`);
  console.log(`Cutoff period      : ${cutoffPeriod.periodStart.toISOString().slice(0,10)} → ${cutoffPeriod.periodEnd.toISOString().slice(0,10)}`);
  console.log(`Threshold          : ${threshold}h`);
  console.log(`Training hours     : ${trainingHours.toFixed(2)}h`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`OLD (Bug 6)  total : ${oldTotal.toFixed(2)}h  →  OT = ${oldOt.toFixed(2)}h`);
  console.log(`NEW (superseded) total: ${newTotal.toFixed(2)}h  →  OT = ${newOt.toFixed(2)}h`);
  console.log("═══════════════════════════════════════════════════════════════");

  const existingBlock = await prisma.cutoffOtBlock.findUnique({
    where: { cutoffPeriodId_userId_date: { cutoffPeriodId: cutoffPeriod.id, userId: user.id, date: cutoffPeriod.periodEnd } },
  });
  console.log(`\nStored CutoffOtBlock.otHours (not yet recomputed): ${existingBlock?.otHours ?? "none"}  status: ${existingBlock?.status ?? "n/a"}`);
  console.log("(Read-only check — no writes performed.)");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
