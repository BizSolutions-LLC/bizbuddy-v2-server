// scripts/check-bb065-find-by-shape.js
//
// BB-065 — Every identity-based search so far (by approver id, by employee id,
// by UTC date range, by UTC clock hour) has come back empty for the Jul 29
// 08:00-13:30 "Forgot To Clock" 4.50h pending request shown in the screenshot.
// Also checked: are there multiple "Jane Horowitz" users? (see output below).
//
// This drops identity assumptions entirely and searches by the request's shape:
//   - gross duration (requestedClockOut - requestedClockIn) is exactly 330 min (5.5h)
//   - reason contains "clock" (case-insensitive) — matches "Forgot To Clock" etc.
// across ALL statuses and ALL dates, so we find the real record regardless of
// who it's actually tied to or whether its status has since changed.
//
// READ-ONLY — no writes.
//
// Usage: node scripts/check-bb065-find-by-shape.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

function fmtUtc(d) {
  return d ? new Date(d).toISOString() : "—";
}

function fmtLocal(d, tz) {
  if (!d) return "—";
  return moment(d).tz(tz || "UTC").format("YYYY-MM-DD (ddd) hh:mm A z");
}

async function main() {
  // ── Any duplicate "Jane Horowitz" users? ─────────────────────────────────
  const janes = await prisma.user.findMany({
    where: {
      profile: { firstName: { equals: "Jane", mode: "insensitive" }, lastName: { equals: "Horowitz", mode: "insensitive" } },
    },
    select: { id: true, email: true, companyId: true, role: true },
  });
  console.log(`=== Users named "Jane Horowitz": ${janes.length} ===`);
  for (const j of janes) {
    console.log(`  id=${j.id} email=${j.email} companyId=${j.companyId} role=${j.role}`);
  }

  // ── Search by shape: ~330 min duration + reason mentions "clock" ─────────
  const all = await prisma.requestedTimeLog.findMany({
    select: {
      id: true,
      status: true,
      reason: true,
      requestedDate: true,
      requestedClockIn: true,
      requestedClockOut: true,
      estimatedDuration: true,
      estimatedNetHours: true,
      submittedAt: true,
      approverId: true,
      userId: true,
      user: {
        select: {
          email: true,
          profile: { select: { firstName: true, lastName: true } },
          company: { select: { name: true, timeZone: true } },
        },
      },
    },
  });

  const shapeMatches = all.filter((r) => {
    const durationMin = Math.round(
      (new Date(r.requestedClockOut).getTime() - new Date(r.requestedClockIn).getTime()) / 60000
    );
    const reasonMatches = (r.reason || "").toLowerCase().includes("clock");
    return durationMin === 330 && reasonMatches;
  });

  console.log(`\n=== Requests (any status, any user) with 5.5h duration + reason mentioning "clock": ${shapeMatches.length} ===`);
  for (const r of shapeMatches) {
    const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
    const tz = r.user?.company?.timeZone || "UTC";
    console.log(`  --- ${r.id} ---`);
    console.log(`    employee: ${name} (userId=${r.userId})  company: ${r.user?.company?.name || "—"}`);
    console.log(`    status: ${r.status}  reason: "${r.reason}"`);
    console.log(`    requestedDate: local=${fmtLocal(r.requestedDate, tz)}  UTC=${fmtUtc(r.requestedDate)}`);
    console.log(`    requestedClockIn: local=${fmtLocal(r.requestedClockIn, tz)}  UTC=${fmtUtc(r.requestedClockIn)}`);
    console.log(`    requestedClockOut: local=${fmtLocal(r.requestedClockOut, tz)}  UTC=${fmtUtc(r.requestedClockOut)}`);
    console.log(`    estimatedDuration: ${r.estimatedDuration} min  estimatedNetHours: ${r.estimatedNetHours}`);
    console.log(`    approverId: ${r.approverId || "—"}`);
    console.log(`    submittedAt: ${fmtUtc(r.submittedAt)}`);
  }

  // ── Also: broaden to duration 300-360 min (5.0-6.0h) in case 5.5h isn't exact ──
  const nearMatches = all.filter((r) => {
    const durationMin = Math.round(
      (new Date(r.requestedClockOut).getTime() - new Date(r.requestedClockIn).getTime()) / 60000
    );
    const reasonMatches = (r.reason || "").toLowerCase().includes("clock");
    return durationMin >= 300 && durationMin <= 360 && reasonMatches && durationMin !== 330;
  });
  if (nearMatches.length > 0) {
    console.log(`\n=== Near-matches (300-360 min, excluding exact 330, reason mentions "clock"): ${nearMatches.length} ===`);
    for (const r of nearMatches) {
      const name = r.user?.profile ? `${r.user.profile.firstName} ${r.user.profile.lastName}` : r.user?.email;
      const durationMin = Math.round(
        (new Date(r.requestedClockOut).getTime() - new Date(r.requestedClockIn).getTime()) / 60000
      );
      console.log(`  id=${r.id} employee=${name} status=${r.status} durationMin=${durationMin} estimatedNetHours=${r.estimatedNetHours}`);
    }
  }

  console.log(`\n=== Total RequestedTimeLog rows in table (sanity check): ${all.length} ===`);
  console.log("\nNo changes were made by this script.");
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
