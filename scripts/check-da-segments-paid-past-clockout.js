// scripts/check-da-segments-paid-past-clockout.js
//
// BB-124 follow-up. READ-ONLY. Driver/Aide segment approvals paid PAST the employee's real clock-out:
// an approved AM / Regular / PM segment whose approved end is after the punch's
// clock-out (the employee left before the segment ended).
//
// Rule (user, 2026-11-25): Schedule = the company accepts the fixed segment window
// (paying past an early clock-out is the approver's choice, correct); Raw = what
// actually happened (must end at the clock-out). Until the 2026-11-25 fix, Raw ended
// AM / Regular at the segment end anyway (daycareCutoffStrategy: only the last
// segment used the real clock-out), so a Raw approval here was overpaid.
//
// The approval does NOT store which button was used, so each row shows a guess:
//   Schedule — the day's LAST segment (Raw has always paid it to the real clock-out, so
//              paid past the clock-out = Schedule), or approved start = segment start
//              although the clock-in was later (Schedule snaps)
//   Raw      — approved start = the real clock-in (after the segment start)
//   unknown  — clock-in before the segment start (both buttons store the segment start)
// "Raw hours" = what Raw pays after the fix: max(clock-in, segment start) →
// min(segment end, clock-out), minus lunch inside, 0 if negative. Grace snaps
// (start within 15 min of the segment start) are not applied here, so Raw hours can
// read a few minutes low.
//
// Usage:
//   node scripts/check-da-segments-paid-past-clockout.js                         # PadPro, punches 2026-11-01 → 2026-11-30
//   node scripts/check-da-segments-paid-past-clockout.js --from 2026-10-01 --to 2026-11-30
//   node scripts/check-da-segments-paid-past-clockout.js --company <companyId> --min 0.25   # only gaps ≥ 0.25h

const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const COMPANY_ID = arg("--company", "cmnegwuxm0004rf7fzo6wjrw2"); // default PadPro (by id)
const FROM = arg("--from", "2026-11-01");
const TO = arg("--to", "2026-11-30");
const MIN_GAP = Number(arg("--min", "0.02"));
const r2 = (v) => Math.round(v * 100) / 100;

function lunchOverlapH(lunch, from, to) {
  if (!lunch || !lunch.start || !lunch.end) return 0;
  if (lunch.auto && lunch.deductible === false) return 0;
  const s = Math.max(new Date(lunch.start).getTime(), from.getTime());
  const e = Math.min(new Date(lunch.end).getTime(), to.getTime());
  return e > s ? (e - s) / 36e5 : 0;
}

async function main() {
  const [company] = await prisma.$queryRaw`SELECT "id", "name", "timeZone" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) return console.log(`Company ${COMPANY_ID} not found.`);
  const tz = company.timeZone || "America/Los_Angeles";
  const from = moment.tz(FROM, tz).startOf("day").toDate();
  const to = moment.tz(TO, tz).endOf("day").toDate();

  const rows = await prisma.$queryRaw`
    SELECT a."id", a."segmentType", a."segmentStart", a."segmentEnd", a."approvedClockIn", a."approvedClockOut",
           a."actualHours", a."approvedAt", c."status" AS "cutoffStatus", c."periodStart", c."periodEnd",
           t."id" AS "timeLogId", t."timeIn", t."timeOut", t."punchType"::text AS "punchType", t."lunchBreak",
           p."firstName", p."lastName", u."email"
    FROM "TimeLogApproval" a
    JOIN "TimeLog" t ON t."id" = a."timeLogId"
    JOIN "User" u ON u."id" = t."userId"
    LEFT JOIN "UserProfile" p ON p."userId" = u."id"
    LEFT JOIN "CutoffPeriod" c ON c."id" = a."cutoffPeriodId"
    WHERE u."companyId" = ${COMPANY_ID} AND a."status" = 'approved' AND a."segmentType" IS NOT NULL
      AND t."timeOut" IS NOT NULL AND a."approvedClockOut" IS NOT NULL
      AND a."approvedClockOut" > t."timeOut" + interval '1 minute'
      AND t."timeIn" >= ${from} AND t."timeIn" <= ${to}
    ORDER BY p."lastName", p."firstName", t."timeIn", a."segmentStart"`;

  const fmt = (d) => moment(d).tz(tz).format("h:mm A");
  const nameOf = (r) => `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email;
  const SEG = { driver_am: "AM", regular: "Regular", driver_pm: "PM" };
  const out = [];
  const byMode = { Schedule: [0, 0], Raw: [0, 0], unknown: [0, 0] }; // [rows, gap hours]

  for (const r of rows) {
    const timeIn = new Date(r.timeIn);
    const timeOut = new Date(r.timeOut);
    const segStart = r.segmentStart ? new Date(r.segmentStart) : timeIn;
    const segEnd = r.segmentEnd ? new Date(r.segmentEnd) : timeOut;
    const rawFrom = new Date(Math.max(timeIn.getTime(), segStart.getTime()));
    const rawTo = new Date(Math.min(segEnd.getTime(), timeOut.getTime()));
    const rawH = rawTo > rawFrom ? r2((rawTo - rawFrom) / 36e5 - lunchOverlapH(r.lunchBreak, rawFrom, rawTo)) : 0;
    const paid = r2(Number(r.actualHours) || 0);
    const gap = r2(paid - rawH);
    if (gap < MIN_GAP) continue;

    // Last segment of the day: DRIVER_AIDE / DRIVER_AIDE_PM → PM, DRIVER_AIDE_AM → Regular.
    const lastSeg = r.punchType === "DRIVER_AIDE_AM" ? "regular" : "driver_pm";
    let mode = "unknown";
    if (r.segmentType === lastSeg) mode = "Schedule";
    else if (timeIn > segStart) {
      const ai = new Date(r.approvedClockIn).getTime();
      if (Math.abs(ai - segStart.getTime()) < 60000) mode = "Schedule";
      else if (Math.abs(ai - timeIn.getTime()) < 60000) mode = "Raw";
    }
    byMode[mode][0] += 1;
    byMode[mode][1] += gap;
    const period = r.periodStart ? `${new Date(r.periodStart).toISOString().slice(0, 10)}→${new Date(r.periodEnd).toISOString().slice(0, 10)} ${r.cutoffStatus}` : "no cutoff";
    out.push(
      `${nameOf(r)} | ${moment(r.timeIn).tz(tz).format("YYYY-MM-DD")} | ${r.punchType} | punch ${fmt(timeIn)} → ${fmt(timeOut)} | ` +
        `${SEG[r.segmentType] || r.segmentType} ${fmt(segStart)}–${fmt(segEnd)} | paid ${paid}h (to ${fmt(r.approvedClockOut)}) | Raw would pay ${rawH}h | +${gap}h | button: ${mode} | cutoff ${period}`
    );
  }

  console.log(`\n${company.name} (${tz}), Driver/Aide segments paid past the clock-out, punches ${FROM} → ${TO}${MIN_GAP > 0.02 ? `, gap ≥ ${MIN_GAP}h` : ""}\n`);
  out.forEach((l) => console.log(l));
  console.log(`\n${out.length} segment(s).`);
  for (const [m, [k, h]] of Object.entries(byMode)) if (k) console.log(`  ${m}: ${k} segment(s), ${r2(h)}h paid past the clock-out`);
  console.log("\nSchedule = correct by the rule (the company accepts the fixed window). Raw = overpaid before the fix: Reset + approve again with Raw (open cutoffs).");
  console.log("unknown = the button can't be told apart from the data; check with the approver.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
