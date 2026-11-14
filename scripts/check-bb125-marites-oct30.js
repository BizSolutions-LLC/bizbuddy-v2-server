// scripts/check-bb125-marites-oct30.js
//
// BB-125 — Marites Fernandez (Piedmont Adult Day Program), Oct 30 2026.
// READ-ONLY. Writes nothing.
//
// She worked her full shift on 10-30 (punch approved, 5.5h) while an approved
// 5.5h paid Sick Leave also covers 10-30. PadPro has leaveConflictAutoRevert on,
// so the punch should have won AND the leave should have been cancelled and
// refunded. Suspected BB-073: resolveConflict's leave lookup compares the noon
// leave timestamp to the morning punch, finds nothing, and silently skips the
// cancel + refund.
//
// Prints:
//   - company toggle, user
//   - every TimeLog on 10-30 (company zone) with its approvals
//     (status, approvedBy, notes, approved times/hours, cutoff status)
//   - every leave touching 10-30: status, paid/unpaid, LeaveDay rows, ledger
//   - her current balance for that leave's policy
//   - a verdict: is this the BB-073 pattern?
//
// Usage:
//   node scripts/check-bb125-marites-oct30.js

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const moment = require("moment-timezone");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const COMPANY_ID = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program ("PadPro")
const EMPLOYEE_EMAIL = "navzferz_1368@yahoo.com";
const LOCAL_DATE = "2026-10-30";

function fmt(d, tz) {
  return d ? moment.tz(d, tz).format("YYYY-MM-DD hh:mm A z") : "—";
}

async function main() {
  const company = await prisma.company.findUnique({
    where:  { id: COMPANY_ID },
    select: { id: true, name: true, timeZone: true, leaveConflictAutoRevert: true },
  });
  if (!company) throw new Error(`Company ${COMPANY_ID} not found`);
  const tz = company.timeZone || "America/Los_Angeles";

  const users = await prisma.user.findMany({
    where:  { companyId: COMPANY_ID, email: { equals: EMPLOYEE_EMAIL, mode: "insensitive" } },
    select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (users.length !== 1) throw new Error(`Expected 1 user with ${EMPLOYEE_EMAIL} in PadPro, found ${users.length}`);
  const user = users[0];
  const name = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" ");

  console.log(`Company: ${company.name} (${company.id}) tz=${tz} leaveConflictAutoRevert=${company.leaveConflictAutoRevert}`);
  console.log(`User:    ${name} <${user.email}> (${user.id})\n`);

  // ── Punches on the day ──
  const dayStart = moment.tz(LOCAL_DATE, tz).startOf("day").toDate();
  const dayEnd   = moment.tz(LOCAL_DATE, tz).endOf("day").toDate();
  const timeLogs = await prisma.timeLog.findMany({
    where:   { userId: user.id, timeIn: { gte: dayStart, lte: dayEnd } },
    orderBy: { timeIn: "asc" },
    select: {
      id: true, punchType: true, timeIn: true, timeOut: true, originalTimeIn: true, originalTimeOut: true,
      isApproved: true, autoClockOut: true, netWorkedHours: true,
      approvals: {
        select: {
          id: true, segmentType: true, status: true, approvedBy: true, approvedAt: true, notes: true,
          approvedClockIn: true, approvedClockOut: true, scheduledHours: true, actualHours: true,
          cutoffPeriod: { select: { id: true, status: true } },
        },
      },
    },
  });

  console.log(`TimeLogs on ${LOCAL_DATE}: ${timeLogs.length}`);
  for (const t of timeLogs) {
    console.log(`  ${t.id} ${t.punchType} isApproved=${t.isApproved} autoClockOut=${t.autoClockOut} net=${t.netWorkedHours}`);
    console.log(`    current : ${fmt(t.timeIn, tz)} → ${fmt(t.timeOut, tz)}`);
    console.log(`    original: ${fmt(t.originalTimeIn, tz)} → ${fmt(t.originalTimeOut, tz)}`);
    for (const a of t.approvals) {
      console.log(`    approval ${a.id} ${a.segmentType ?? "(regular)"} status=${a.status} approvedBy=${a.approvedBy ?? "null"} at=${fmt(a.approvedAt, tz)} cutoff=${a.cutoffPeriod?.id ?? "—"} (${a.cutoffPeriod?.status ?? "—"})`);
      console.log(`      approved: ${fmt(a.approvedClockIn, tz)} → ${fmt(a.approvedClockOut, tz)} sched=${a.scheduledHours} actual=${a.actualHours}`);
      console.log(`      notes   : ${a.notes ?? ""}`);
    }
  }

  // ── Leaves touching the day (calendar-date match, like the cutoff review) ──
  const candidates = await prisma.leave.findMany({
    where: {
      userId:    user.id,
      startDate: { lte: moment.tz(LOCAL_DATE, tz).add(1, "day").endOf("day").toDate() },
      endDate:   { gte: moment.tz(LOCAL_DATE, tz).subtract(1, "day").startOf("day").toDate() },
    },
    select: {
      id: true, leaveType: true, policyId: true, status: true, isPaid: true, startDate: true, endDate: true,
      actualPaidHours: true, actualUnpaidHours: true, leaveReason: true, approverComments: true, createdAt: true,
    },
  });
  const leaves = candidates.filter((l) => {
    const s = l.startDate.toISOString().slice(0, 10);
    const e = l.endDate.toISOString().slice(0, 10);
    return LOCAL_DATE >= s && LOCAL_DATE <= e;
  });

  const policyIds = [...new Set(leaves.map((l) => l.policyId || l.leaveType).filter(Boolean))];
  const policies = policyIds.length
    ? await prisma.leavePolicy.findMany({ where: { id: { in: policyIds } }, select: { id: true, leaveType: true } })
    : [];
  const policyName = new Map(policies.map((p) => [p.id, p.leaveType]));

  console.log(`\nLeaves covering ${LOCAL_DATE}: ${leaves.length}`);
  for (const l of leaves) {
    const pid = l.policyId || l.leaveType;
    console.log(`  ${l.id} ${policyName.get(pid) || l.leaveType} status=${l.status} isPaid=${l.isPaid} paid=${l.actualPaidHours} unpaid=${l.actualUnpaidHours}`);
    console.log(`    dates: ${l.startDate.toISOString()} → ${l.endDate.toISOString()}  reason="${l.leaveReason ?? ""}"  comments="${l.approverComments ?? ""}"`);

    const days = await prisma.leaveDay.findMany({ where: { leaveId: l.id }, orderBy: { date: "asc" } });
    for (const d of days) console.log(`    LeaveDay ${d.date.toISOString().slice(0, 10)} ${d.hours}h ${d.isPaid ? "paid" : "unpaid"}`);

    const ledger = await prisma.leaveTransaction.findMany({
      where:   { leaveId: l.id },
      orderBy: { createdAt: "asc" },
      select:  { type: true, hours: true, balanceBefore: true, balanceAfter: true, note: true, createdAt: true },
    });
    for (const x of ledger) {
      console.log(`    ledger ${x.createdAt.toISOString()} ${x.type} hours=${x.hours} ${x.balanceBefore}→${x.balanceAfter} ${x.note ?? ""}`);
    }

    if (pid) {
      const bal = await prisma.leaveBalance.findUnique({
        where:  { userId_policyId: { userId: user.id, policyId: pid } },
        select: { balanceHours: true, updatedAt: true },
      });
      console.log(`    current balance (${policyName.get(pid) || pid}): ${bal ? bal.balanceHours : "no balance row"}`);
    }
  }

  // ── Verdict ──
  const approvedPunch = timeLogs.some((t) => t.approvals.some((a) => a.status === "approved"));
  const autoResolved  = timeLogs.some((t) => t.approvals.some((a) => a.approvedBy == null && /punch takes precedence/i.test(a.notes || "")));
  const stillApproved = leaves.filter((l) => l.status === "approved");
  console.log("\nVerdict:");
  console.log(`  approved punch on ${LOCAL_DATE}: ${approvedPunch}`);
  console.log(`  auto-resolved "punch takes precedence" (approvedBy null): ${autoResolved}`);
  console.log(`  leave(s) still approved on that day: ${stillApproved.length}`);
  if (approvedPunch && stillApproved.length) {
    console.log(autoResolved
      ? "  → BB-073 pattern: the punch was honored automatically but the leave was never cancelled/refunded."
      : "  → Punch and leave are both approved, but not via the auto-revert note — check who approved the punch.");
  } else {
    console.log("  → Not the BB-073 pattern — share this output before any fix.");
  }
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
