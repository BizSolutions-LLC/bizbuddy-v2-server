// scripts/check-bb101-lennie-oct11.js
//
// BB-101 — Lennie Capulong (Piedmont Adult Day Program) needs a punch added
// for Sunday 2026-10-11. Before adding it (in-app via Request Punch Log on her
// behalf → approve), confirm:
//   1. Her department.
//   2. Her scheduled shift(s) on 10/11, if any (Sunday).
//   3. Any punch she already has 10/09–10/13 (an overlap would block approval).
//   4. Any punch request already filed for 10/11 (pending / approved / rejected).
//   5. Any leave covering 10/11 (would raise a leave conflict on the cutoff).
//   6. The cutoff period covering 10/11 and its status. approveRequestedPunchLog
//      does NOT check for a locked/processed cutoff, so this decides whether
//      the in-app path is safe.
//
// READ-ONLY — SELECTs only, no writes, no files written.
//
// Usage: node scripts/check-bb101-lennie-oct11.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID  = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const USER_ID     = "cmnei2ajg0091nr4u2p5cc7rf"; // Lennie Capulong
const TARGET_DATE = "2026-10-11";
const WINDOW_DAYS = 2; // punches checked TARGET_DATE ± this many days

async function main() {
  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { name: true, timeZone: true, minimumLunchMinutes: true },
  });
  const tz = company?.timeZone || "America/Los_Angeles";
  const fmt = (d) => (d ? moment.tz(d, tz).format("ddd YYYY-MM-DD hh:mm A") : "—");

  const dayStart = moment.tz(TARGET_DATE, tz).startOf("day").toDate();
  const dayEnd   = moment.tz(TARGET_DATE, tz).endOf("day").toDate();
  const winStart = moment.tz(TARGET_DATE, tz).subtract(WINDOW_DAYS, "days").startOf("day").toDate();
  const winEnd   = moment.tz(TARGET_DATE, tz).add(WINDOW_DAYS, "days").endOf("day").toDate();

  // ── 1. User ──────────────────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where:  { id: USER_ID },
    select: {
      email: true, status: true, companyId: true, departmentId: true, role: true,
      department: { select: { name: true } },
      profile:    { select: { firstName: true, lastName: true } },
    },
  });
  if (!user) throw new Error(`User ${USER_ID} not found`);
  if (user.companyId !== COMPANY_ID) throw new Error(`User ${USER_ID} is not in ${COMPANY_ID}`);

  console.log(`Company: ${company.name} (tz ${tz}, minimumLunchMinutes ${company.minimumLunchMinutes})`);
  console.log(`User: ${user.profile?.firstName} ${user.profile?.lastName} <${user.email}> — ${user.status}, role ${user.role}`);
  console.log(`Department: ${user.department?.name ?? "(none)"} (${user.departmentId ?? "null"})`);
  console.log(`Target date: ${TARGET_DATE} (${moment.tz(TARGET_DATE, tz).format("dddd")})`);

  // ── 2. Scheduled shifts on the date ──────────────────────────────────────
  const shifts = await prisma.userShift.findMany({
    where:   { userId: USER_ID, assignedDate: new Date(`${TARGET_DATE}T00:00:00.000Z`) },
    include: { shift: { select: { shiftName: true, startTime: true, endTime: true } } },
  }).catch(async () =>
    // shiftName may not exist on every schema version — fall back to the bare shift
    prisma.userShift.findMany({
      where:   { userId: USER_ID, assignedDate: new Date(`${TARGET_DATE}T00:00:00.000Z`) },
      include: { shift: true },
    })
  );
  console.log(`\n--- Scheduled shifts on ${TARGET_DATE} ---`);
  if (!shifts.length) console.log("  (none — no schedule on this day)");
  for (const s of shifts) {
    const t = (d) => (d ? new Date(d).toISOString().slice(11, 16) : "—");
    console.log(
      `  ${s.id} | ${s.shift?.shiftName ?? s.shiftId} | ${t(s.customStartTime ?? s.shift?.startTime)}–${t(s.customEndTime ?? s.shift?.endTime)}` +
      ` | status ${s.status} | from ${s.createdFrom ?? "—"}`
    );
  }

  // ── 3. Existing punches around the date ──────────────────────────────────
  const logs = await prisma.timeLog.findMany({
    where:   { userId: USER_ID, timeIn: { gte: winStart, lte: winEnd } },
    orderBy: { timeIn: "asc" },
    select: {
      id: true, timeIn: true, timeOut: true, punchType: true, netWorkedHours: true,
      lunchBreak: true, lunchDeductionMinutes: true, status: true,
      approvals: { select: { status: true, segmentType: true, cutoffPeriodId: true } },
    },
  });
  console.log(`\n--- Punches ${moment(winStart).tz(tz).format("MM/DD")}–${moment(winEnd).tz(tz).format("MM/DD")} ---`);
  if (!logs.length) console.log("  (none)");
  for (const l of logs) {
    const onTarget = l.timeIn >= dayStart && l.timeIn <= dayEnd ? "  ◀ ON TARGET DATE" : "";
    const appr = l.approvals.map((a) => `${a.segmentType ?? "regular"}:${a.status}`).join(", ") || "no approval row";
    console.log(
      `  ${l.id} | ${l.punchType} | ${fmt(l.timeIn)} → ${fmt(l.timeOut)} | net ${l.netWorkedHours ?? "—"}h` +
      ` | lunch ${l.lunchDeductionMinutes ?? "—"}min | ${appr}${onTarget}`
    );
  }

  // ── 4. Punch requests for the date ───────────────────────────────────────
  const requests = await prisma.requestedTimeLog.findMany({
    where: {
      userId: USER_ID,
      OR: [
        { requestedDate:    { gte: winStart, lte: winEnd } },
        { requestedClockIn: { gte: dayStart, lte: dayEnd } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n--- Punch requests around ${TARGET_DATE} ---`);
  if (!requests.length) console.log("  (none)");
  for (const r of requests) {
    console.log(
      `  ${r.id} | ${r.status} | ${fmt(r.requestedClockIn)} → ${fmt(r.requestedClockOut)} | type ${r.requestedPunchType ?? "—"}` +
      ` | created ${fmt(r.createdAt)}${r.createdByUserId ? " (filed on behalf)" : ""}` +
      (r.createdTimeLogId ? ` | created log ${r.createdTimeLogId}` : "") +
      (r.rejectionReason ? ` | rejected: ${r.rejectionReason}` : "")
    );
  }

  // ── 5. Leave covering the date ───────────────────────────────────────────
  const leaves = await prisma.leave.findMany({
    where:  { userId: USER_ID, startDate: { lte: dayEnd }, endDate: { gte: dayStart } },
    select: { id: true, status: true, leaveType: true, startDate: true, endDate: true, policy: { select: { leaveType: true } } },
  });
  console.log(`\n--- Leave covering ${TARGET_DATE} ---`);
  if (!leaves.length) console.log("  (none)");
  for (const lv of leaves) {
    console.log(`  ${lv.id} | ${lv.policy?.leaveType ?? lv.leaveType} | ${lv.status} | ${fmt(lv.startDate)} → ${fmt(lv.endDate)}`);
  }

  // ── 6. Cutoff period covering the date ───────────────────────────────────
  // periodEnd is stored as UTC midnight of the last day — widen to EOD in tz.
  const periods = await prisma.cutoffPeriod.findMany({
    where: {
      companyId: COMPANY_ID,
      OR: [{ departmentId: user.departmentId ?? null }, { departmentId: null }],
      periodStart: { lte: dayEnd },
      periodEnd:   { gte: moment.tz(TARGET_DATE, tz).subtract(1, "day").startOf("day").toDate() },
    },
    include: { department: { select: { name: true } } },
    orderBy: { periodStart: "asc" },
  });
  console.log(`\n--- Cutoff period(s) covering ${TARGET_DATE} ---`);
  const covering = periods.filter((p) => {
    const startStr = new Date(p.periodStart).toISOString().slice(0, 10);
    const endStr   = new Date(p.periodEnd).toISOString().slice(0, 10);
    return startStr <= TARGET_DATE && TARGET_DATE <= endStr;
  });
  if (!covering.length) console.log("  (none found — no cutoff generated for this date yet)");
  for (const p of covering) {
    const approvals = await prisma.timeLogApproval.groupBy({
      by:    ["status"],
      where: { cutoffPeriodId: p.id, timeLog: { userId: USER_ID } },
      _count: { _all: true },
    });
    const mine = approvals.map((a) => `${a.status}:${a._count._all}`).join(", ") || "none";
    console.log(
      `  ${p.id} | ${new Date(p.periodStart).toISOString().slice(0, 10)} → ${new Date(p.periodEnd).toISOString().slice(0, 10)}` +
      ` | dept ${p.department?.name ?? "(company-wide)"} | STATUS ${p.status.toUpperCase()}` +
      ` | pay ${new Date(p.paymentDate).toISOString().slice(0, 10)} | Lennie's approvals: ${mine}`
    );
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log("\n--- Verdict ---");
  const onDay = logs.filter((l) => l.timeIn >= dayStart && l.timeIn <= dayEnd);
  const pendingReq = requests.filter((r) => r.status === "PENDING");
  const closed = covering.filter((p) => p.status !== "open");
  if (onDay.length) console.log(`  ⚠️ She already has ${onDay.length} punch(es) on ${TARGET_DATE} — check the times before adding another.`);
  if (pendingReq.length) console.log(`  ⚠️ ${pendingReq.length} pending punch request(s) already filed — approve that instead of filing a new one.`);
  if (leaves.length) console.log("  ⚠️ A leave covers this date — the new punch will raise a leave conflict on the cutoff.");
  if (closed.length) console.log(`  ⛔ Cutoff is ${closed.map((p) => p.status).join("/")} — do NOT approve in-app until we decide (reopen vs. carry over).`);
  else if (covering.length) console.log("  ✅ Cutoff is open — in-app path is safe: file on her behalf → approve → (lunch via BB-102) → Sync the cutoff.");
  else console.log("  ✅ No cutoff yet — in-app path is safe; the punch is picked up when the cutoff is generated.");
}

main()
  .catch((err) => {
    console.error("Check failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
