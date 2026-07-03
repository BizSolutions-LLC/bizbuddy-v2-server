// scripts/backfill-ot-dryrun.js
// Read-only. Finds every (cutoffPeriod, user) pair on a cutoff-basis company
// where the old (Bug 6) OT formula and the new (TR-excluded) OT formula
// disagree, and prints a diff. Does NOT write anything — use this to scope
// the backfill before running it.

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const companies = await prisma.company.findMany({
    where:  { otBasis: "cutoff" },
    select: { id: true, name: true, cutoffOtThresholdHours: true },
  });

  console.log(`Cutoff-basis companies: ${companies.length}\n`);

  let totalAffected = 0;
  let totalLockedOrProcessed = 0;

  for (const company of companies) {
    const threshold = parseFloat(company.cutoffOtThresholdHours ?? 80);

    const periods = await prisma.cutoffPeriod.findMany({
      where:  { companyId: company.id },
      select: { id: true, periodStart: true, periodEnd: true, status: true },
    });

    for (const period of periods) {
      const approved = await prisma.timeLogApproval.findMany({
        where: {
          cutoffPeriodId: period.id,
          status:  "approved",
          timeLog: { punchType: "TRAINING" },
        },
        select: { id: true, timeLog: { select: { userId: true } } },
      });

      const affectedUserIds = [...new Set(approved.map((a) => a.timeLog.userId))];
      if (affectedUserIds.length === 0) continue;

      for (const userId of affectedUserIds) {
        const records = await prisma.timeLogApproval.findMany({
          where: {
            cutoffPeriodId: period.id,
            status:  "approved",
            timeLog: { userId },
          },
          select: {
            actualHours:      true,
            approvedClockIn:  true,
            approvedClockOut: true,
            timeLog: { select: { netWorkedHours: true, punchType: true } },
          },
        });

        let oldTotal = 0, newTotal = 0, trainingHours = 0;
        for (const a of records) {
          const hours = a.actualHours != null
            ? parseFloat(a.actualHours.toString())
            : a.approvedClockIn && a.approvedClockOut
              ? (new Date(a.approvedClockOut) - new Date(a.approvedClockIn)) / 3600000
              : parseFloat(a.timeLog?.netWorkedHours?.toString() ?? 0);
          oldTotal += hours;
          if (a.timeLog?.punchType === "TRAINING") trainingHours += hours;
          else newTotal += hours;
        }

        const oldOt = parseFloat(Math.max(0, oldTotal - threshold).toFixed(2));
        const newOt = parseFloat(Math.max(0, newTotal - threshold).toFixed(2));
        if (Math.abs(oldOt - newOt) < 0.01) continue; // no actual change

        const block = await prisma.cutoffOtBlock.findUnique({
          where: { cutoffPeriodId_userId_date: { cutoffPeriodId: period.id, userId, date: period.periodEnd } },
          select: { otHours: true, status: true },
        });

        const user = await prisma.user.findUnique({
          where: { id: userId },
          include: { profile: true },
        });

        totalAffected++;
        if (period.status !== "open") totalLockedOrProcessed++;

        console.log("───────────────────────────────────────────────────────────────");
        console.log(`Company     : ${company.name}`);
        console.log(`User        : ${user?.profile?.firstName ?? "?"} ${user?.profile?.lastName ?? "?"} (${userId})`);
        console.log(`Period      : ${period.periodStart.toISOString().slice(0,10)} → ${period.periodEnd.toISOString().slice(0,10)}  [status: ${period.status}]`);
        console.log(`Training    : ${trainingHours.toFixed(2)}h`);
        console.log(`OLD total/OT: ${oldTotal.toFixed(2)}h / ${oldOt.toFixed(2)}h OT`);
        console.log(`NEW total/OT: ${newTotal.toFixed(2)}h / ${newOt.toFixed(2)}h OT   (Δ ${(newOt - oldOt).toFixed(2)}h)`);
        console.log(`Stored block: otHours=${block?.otHours ?? "none"} status=${block?.status ?? "n/a"}`);
      }
    }
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`TOTAL affected (period, user) pairs : ${totalAffected}`);
  console.log(`Of which in locked/processed periods : ${totalLockedOrProcessed}`);
  console.log("(Read-only — no writes performed.)");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
