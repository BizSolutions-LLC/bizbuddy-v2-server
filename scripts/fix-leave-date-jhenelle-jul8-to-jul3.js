// scripts/fix-leave-date-jhenelle-jul8-to-jul3.js
// Fix: correct Jhenelle Villanueva's approved Sick Leave date — was submitted
// as Jul 8 but should be Jul 3. Date-only correction; balance/ledger untouched
// per explicit instruction.
//
// Usage:
//   node scripts/fix-leave-date-jhenelle-jul8-to-jul3.js            (dry run)
//   node scripts/fix-leave-date-jhenelle-jul8-to-jul3.js --apply    (commit)

require("module-alias/register");
const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");

const prisma = new PrismaClient();

const LEAVE_ID = "cmrcalddl1fjwvh50sbju86qq";
const NEW_DATE = "2026-07-03"; // was 2026-07-08
const DRY_RUN  = !process.argv.includes("--apply");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "🔍 DRY RUN — pass --apply to commit changes" : "✏️  APPLYING changes");
  console.log(`Leave ID : ${LEAVE_ID}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const leave = await prisma.leave.findUnique({
    where:   { id: LEAVE_ID },
    include: { User: { include: { company: true } } },
  });

  if (!leave) {
    console.log("❌ Leave not found.");
    return;
  }

  const oldStart = leave.startDate.toISOString().slice(0, 10);
  const oldEnd   = leave.endDate.toISOString().slice(0, 10);
  console.log(`Current : ${oldStart} → ${oldEnd}  status=${leave.status}  isPaid=${leave.isPaid}`);

  if (oldStart !== "2026-07-08" || oldEnd !== "2026-07-08") {
    console.log(`⚠️  Expected current date to be 2026-07-08, got ${oldStart} → ${oldEnd}. Aborting.`);
    return;
  }

  const tz = leave.User.company?.timeZone || "America/Los_Angeles";
  const newDateISO = moment.tz(NEW_DATE, tz).hour(12).minute(0).second(0).millisecond(0).toISOString();

  console.log(`New     : ${NEW_DATE} → ${NEW_DATE}`);
  console.log("(No changes to LeaveTransaction or LeaveBalance — date-only fix.)");

  if (DRY_RUN) {
    console.log("\n(dry run — no changes written)");
    return;
  }

  await prisma.leave.update({
    where: { id: LEAVE_ID },
    data:  { startDate: newDateISO, endDate: newDateISO },
  });

  console.log("\n✅ Done — Leave date updated to 2026-07-03.");
  console.log("═══════════════════════════════════════════════════════");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
