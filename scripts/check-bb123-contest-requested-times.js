// scripts/check-bb123-contest-requested-times.js
//
// BB-123 diagnostic: has the web contest dialog bug (requested times built in the
// browser's zone, overnight clock-out put on the same day) already produced bad
// contests, and did any approved one write bad times to its time log?
// This is a READ-ONLY script: no writes.
//
// Flags per contest (any status):
//   BACKWARDS   requested clock-out is not after requested clock-in
//   TOO_LONG    requested shift is 24h or longer
//   FAR         requested clock-in is FAR_HOURS+ away from the recorded clock-in
//               (a hint of a zone shift; Manila vs LA is 15-16h. Legit corrections can be large too)
//   MISSING     requested clock-in or clock-out is empty
// For APPROVED contests it also shows whether the time log now holds the
// requested times, and flags LOG_BACKWARDS when the time log itself is backwards.
//
// Times are printed in each company's time zone, plus UTC.
//
// Usage: node scripts/check-bb123-contest-requested-times.js
//        node scripts/check-bb123-contest-requested-times.js --all   (also list unflagged)

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const FAR_HOURS = 12;
const SHOW_ALL = process.argv.includes("--all");

function fmt(d, tz) {
  if (!d) return "—";
  return `${moment(d).tz(tz).format("ddd MMM D, YYYY h:mm A")} (${moment(d).utc().format("YYYY-MM-DD HH:mm")}Z)`;
}

function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 3_600_000;
}

async function main() {
  const contests = await prisma.contestTimeLog.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      timeLog: {
        select: {
          id: true, timeIn: true, timeOut: true,
          user: {
            select: {
              email: true,
              profile: { select: { firstName: true, lastName: true } },
              company: { select: { name: true, timeZone: true } },
            },
          },
        },
      },
    },
  });

  console.log(`Contests in total: ${contests.length}\n`);

  const counts = { BACKWARDS: 0, TOO_LONG: 0, FAR: 0, MISSING: 0, LOG_BACKWARDS: 0 };
  let flaggedRows = 0;

  for (const c of contests) {
    const tz   = c.timeLog?.user?.company?.timeZone || "America/Los_Angeles";
    const flags = [];

    if (!c.requestedClockIn || !c.requestedClockOut) {
      flags.push("MISSING");
    } else {
      const len = hoursBetween(c.requestedClockIn, c.requestedClockOut);
      if (len <= 0) flags.push("BACKWARDS");
      if (len >= 24) flags.push("TOO_LONG");
      const recordedIn = c.currentClockIn || c.timeLog?.timeIn;
      if (recordedIn && Math.abs(hoursBetween(recordedIn, c.requestedClockIn)) >= FAR_HOURS) flags.push("FAR");
    }

    let logNote = "";
    if (c.status === "APPROVED" && c.timeLog) {
      const same =
        c.requestedClockIn && c.requestedClockOut && c.timeLog.timeIn && c.timeLog.timeOut &&
        new Date(c.timeLog.timeIn).getTime()  === new Date(c.requestedClockIn).getTime() &&
        new Date(c.timeLog.timeOut).getTime() === new Date(c.requestedClockOut).getTime();
      logNote = same ? "time log = requested times" : "time log differs from requested (edited since?)";
      if (c.timeLog.timeIn && c.timeLog.timeOut && hoursBetween(c.timeLog.timeIn, c.timeLog.timeOut) <= 0) {
        flags.push("LOG_BACKWARDS");
      }
    }

    flags.forEach((f) => counts[f]++);
    if (flags.length) flaggedRows++;
    if (!flags.length && !SHOW_ALL) continue;

    const u = c.timeLog?.user;
    const name = [u?.profile?.firstName, u?.profile?.lastName].filter(Boolean).join(" ") || u?.email || "?";
    console.log(`── ${c.id}  [${c.status}]  ${flags.length ? flags.join(", ") : "ok"}`);
    console.log(`   ${name} <${u?.email ?? "?"}> · ${u?.company?.name ?? "?"} · zone ${tz}`);
    console.log(`   reason: ${c.reason ?? "—"} · submitted ${fmt(c.submittedAt, tz)}`);
    console.log(`   recorded : ${fmt(c.currentClockIn, tz)}  →  ${fmt(c.currentClockOut, tz)}`);
    console.log(`   requested: ${fmt(c.requestedClockIn, tz)}  →  ${fmt(c.requestedClockOut, tz)}`);
    if (c.timeLog) {
      console.log(`   time log ${c.timeLog.id} now: ${fmt(c.timeLog.timeIn, tz)}  →  ${fmt(c.timeLog.timeOut, tz)}`);
    } else {
      console.log("   time log: (deleted)");
    }
    if (logNote) console.log(`   ${logNote}`);
    console.log("");
  }

  console.log("Summary");
  console.log(`  flagged contests: ${flaggedRows} of ${contests.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
