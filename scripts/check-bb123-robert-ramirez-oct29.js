// scripts/check-bb123-robert-ramirez-oct29.js
//
// BB-123 follow-up: Robert Ramirez (Piedmont Adult Day Program / PadPro).
// Contest cmvvht87v07vdp34zn8d9kdwi was APPROVED and moved time log
// cmvtkzxj106futd50rhpt746a from Thu Oct 29 6:30 AM–2:45 PM to Fri Oct 30 6:30 AM–2:30 PM (+24h),
// but the log now reads Fri Oct 30 6:30 AM–2:45 PM. This is a READ-ONLY script: no writes.
//
// Answers:
//   1. Which time logs does Robert have Oct 27 – Nov 1 (company zone)? Is Oct 29 now empty or Oct 30 doubled?
//   2. Every contest on those logs (requested vs accepted, who approved, when).
//   3. The contested log's audit fields (originalTimeIn/Out, updatedAt, autoClockOut, calculatedAt):
//      what changed the clock-out from 2:30 PM back to 2:45 PM?
//   4. TimeLogApproval rows for those logs + their cutoff period (status, payment date):
//      is the moved day already approved / locked / paid?
//   5. His shift assignments Oct 28 – Oct 31.
//
// PadPro is matched by id, never by name.
//
// Usage: node scripts/check-bb123-robert-ramirez-oct29.js

const { PrismaClient } = require("@prisma/client");
const moment = require("moment-timezone");
const prisma = new PrismaClient();

const COMPANY_ID   = "cmnegwuxm0004rf7fzo6wjrw2"; // Piedmont Adult Day Program (PadPro)
const EMAIL        = "aquarius18my@yahoo.com";
const CONTEST_ID   = "cmvvht87v07vdp34zn8d9kdwi";
const TIMELOG_ID   = "cmvtkzxj106futd50rhpt746a";
const WINDOW_FROM  = "2026-10-27";
const WINDOW_TO    = "2026-11-01";

let TZ = "America/Los_Angeles";

function fmt(d) {
  if (!d) return "—";
  return `${moment(d).tz(TZ).format("ddd MMM D h:mm A")} (${moment(d).utc().format("MM-DD HH:mm")}Z)`;
}
function hrs(a, b) {
  return a && b ? ((new Date(b) - new Date(a)) / 3_600_000).toFixed(2) + "h" : "—";
}
function dateOnly(d) {
  return d ? moment.utc(d).format("YYYY-MM-DD") : "—";
}

async function main() {
  const company = await prisma.company.findUnique({ where: { id: COMPANY_ID }, select: { name: true, timeZone: true } });
  if (company?.timeZone) TZ = company.timeZone;
  console.log(`Company: ${company?.name ?? "?"} · zone ${TZ}\n`);

  const user = await prisma.user.findFirst({
    where: { email: EMAIL, companyId: COMPANY_ID },
    select: { id: true, email: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } },
  });
  if (!user) { console.log("User not found in PadPro."); return; }
  console.log(`User: ${user.profile?.firstName} ${user.profile?.lastName} <${user.email}> · id ${user.id} · dept ${user.departmentId ?? "—"}\n`);

  const from = moment.tz(WINDOW_FROM, TZ).startOf("day").toDate();
  const to   = moment.tz(WINDOW_TO, TZ).endOf("day").toDate();

  // 1. Time logs in the window (plus the contested one, wherever it sits now)
  const logs = await prisma.timeLog.findMany({
    where: { userId: user.id, OR: [{ timeIn: { gte: from, lte: to } }, { id: TIMELOG_ID }] },
    orderBy: { timeIn: "asc" },
    select: {
      id: true, timeIn: true, timeOut: true, status: true, punchType: true,
      originalTimeIn: true, originalTimeOut: true, contestedPolicyApproved: true,
      autoClockOut: true, autoClockOutAt: true, createdAt: true, updatedAt: true, calculatedAt: true,
      netWorkedHours: true, grossHours: true, remarks: true,
    },
  });
  console.log(`1. Time logs ${WINDOW_FROM} – ${WINDOW_TO} (${logs.length})`);
  const perDay = {};
  for (const l of logs) {
    const day = moment(l.timeIn).tz(TZ).format("ddd MMM D");
    perDay[day] = (perDay[day] || 0) + 1;
    const mark = l.id === TIMELOG_ID ? "  ◀ contested log" : "";
    console.log(`   ${l.id}  ${fmt(l.timeIn)} → ${fmt(l.timeOut)}  gross ${hrs(l.timeIn, l.timeOut)} · net ${l.netWorkedHours ?? "—"} · ${l.punchType}${l.status ? " · OPEN" : ""}${mark}`);
  }
  console.log("   Logs per day:", Object.entries(perDay).map(([d, n]) => `${d}=${n}`).join(", ") || "none");
  console.log("");

  // 2. Contests on those logs
  const logIds = logs.map((l) => l.id);
  const contests = await prisma.contestTimeLog.findMany({
    where: { timeLogId: { in: logIds } },
    orderBy: { submittedAt: "asc" },
    include: { approver: { select: { email: true, profile: { select: { firstName: true, lastName: true } } } } },
  });
  console.log(`2. Contests on these logs (${contests.length})`);
  for (const c of contests) {
    const who = c.approver ? `${c.approver.profile?.firstName ?? ""} ${c.approver.profile?.lastName ?? ""} <${c.approver.email}>`.trim() : "—";
    console.log(`   ${c.id} [${c.status}]${c.id === CONTEST_ID ? "  ◀ flagged contest" : ""}`);
    console.log(`      log ${c.timeLogId} · reason: ${c.reason ?? "—"} · description: ${c.description ?? "—"}`);
    console.log(`      submitted ${fmt(c.submittedAt)} · decided ${fmt(c.approvedAt)} by ${who}`);
    console.log(`      recorded : ${fmt(c.currentClockIn)} → ${fmt(c.currentClockOut)}`);
    console.log(`      requested: ${fmt(c.requestedClockIn)} → ${fmt(c.requestedClockOut)}`);
    console.log(`      accepted : ${fmt(c.acceptedClockIn)} → ${fmt(c.acceptedClockOut)}`);
  }
  console.log("");

  // 3. Audit fields on the contested log
  const t = logs.find((l) => l.id === TIMELOG_ID);
  console.log("3. Contested log audit fields");
  if (t) {
    console.log(`   now            : ${fmt(t.timeIn)} → ${fmt(t.timeOut)}`);
    console.log(`   original in/out: ${fmt(t.originalTimeIn)} → ${fmt(t.originalTimeOut)}`);
    console.log(`   created ${fmt(t.createdAt)} · updated ${fmt(t.updatedAt)} · calculated ${fmt(t.calculatedAt)}`);
    console.log(`   autoClockOut ${t.autoClockOut} (at ${fmt(t.autoClockOutAt)}) · contestedPolicyApproved ${t.contestedPolicyApproved}`);
    console.log(`   remarks: ${JSON.stringify(t.remarks)}`);
  } else {
    console.log("   Contested time log not found (deleted?).");
  }
  console.log("");

  // 4. Cutoff approvals for these logs
  const approvals = await prisma.timeLogApproval.findMany({
    where: { timeLogId: { in: logIds } },
    orderBy: [{ timeLogId: "asc" }, { segmentType: "asc" }],
    include: {
      cutoffPeriod: { select: { id: true, periodStart: true, periodEnd: true, paymentDate: true, status: true, departmentId: true } },
      approver: { select: { email: true } },
    },
  });
  console.log(`4. Cutoff approvals for these logs (${approvals.length})`);
  for (const a of approvals) {
    const cp = a.cutoffPeriod;
    console.log(`   log ${a.timeLogId}${a.timeLogId === TIMELOG_ID ? " ◀" : ""} · ${a.segmentType ?? "—"} · ${a.status} · actual ${a.actualHours ?? "—"} · edited ${a.editedHours ?? "—"}`);
    console.log(`      approved in/out ${fmt(a.approvedClockIn)} → ${fmt(a.approvedClockOut)} · by ${a.approver?.email ?? "—"} at ${fmt(a.approvedAt)} · updated ${fmt(a.updatedAt)}`);
    if (cp) console.log(`      cutoff ${cp.id}: ${dateOnly(cp.periodStart)} – ${dateOnly(cp.periodEnd)} · pay ${dateOnly(cp.paymentDate)} · ${cp.status}`);
  }
  console.log("");

  // 5. Shift assignments Oct 28 – 31
  const shifts = await prisma.userShift.findMany({
    where: {
      userId: user.id,
      assignedDate: { gte: new Date("2026-10-28T00:00:00Z"), lte: new Date("2026-10-31T00:00:00Z") },
    },
    orderBy: { assignedDate: "asc" },
    include: { shift: { select: { shiftName: true, startTime: true, endTime: true, timeZone: true } } },
  });
  console.log(`5. Shift assignments Oct 28 – 31 (${shifts.length})`);
  for (const s of shifts) {
    const st = s.shift ? `${moment.utc(s.shift.startTime).format("HH:mm")}–${moment.utc(s.shift.endTime).format("HH:mm")} ${s.shift.timeZone ?? ""}` : "—";
    console.log(`   ${dateOnly(s.assignedDate)} · ${s.shift?.shiftName ?? "—"} ${st} · ${s.status ?? ""}`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
