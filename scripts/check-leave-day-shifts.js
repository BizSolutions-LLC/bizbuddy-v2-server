// scripts/check-leave-day-shifts.js
//
// BB-124 follow-up. READ-ONLY. For every approved leave day in a range: which shift(s) the leave
// charged, the punches the employee still made that day, and whether the leave day
// hours match the charged shifts. Built to check partial-day leaves on Driver/Aide
// days (e.g. a sick leave on the Driver PM shift only, AM + Regular worked).
//
// How a leave day's shifts are worked out (same as calcDailyHours / BB-054 / BB-124):
// the employee's non-cancelled UserShifts on that date, minus the ones the request
// deselected (Leave.excludedShiftIds). LeaveDay itself stores only date / hours / paid,
// so this is a live reading: if shifts were changed after approval it can differ.
//
// Each day is classed:
//   FULL       no counted punch that day (the whole day is leave)
//   PARTIAL    punched on other shifts, leave on the rest (what the Payroll Grid
//              and the request details don't show today)
//   OVERLAP    a counted punch overlaps a charged shift window (BB-124 should block this)
//   MISMATCH   LeaveDay hours (paid + unpaid) ≠ charged shift hours
//   NO SHIFT   no shift that day (leave priced by the fallback: requested times / default)
// A day can carry more than one class.
//
// Usage:
//   node scripts/check-leave-day-shifts.js                                   # PadPro, 2026-11-01 → 2026-11-30
//   node scripts/check-leave-day-shifts.js --from 2026-11-11 --to 2026-11-24
//   node scripts/check-leave-day-shifts.js --company <companyId> --name "<part of a name>"
//   node scripts/check-leave-day-shifts.js --only partial                    # partial | overlap | mismatch | full | noshift

const moment = require("moment-timezone");
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const COMPANY_ID = arg("--company", "cmnegwuxm0004rf7fzo6wjrw2"); // default PadPro (by id)
const FROM = arg("--from", "2026-11-01");
const TO = arg("--to", "2026-11-30");
const NAME = arg("--name", null);
const ONLY = arg("--only", null);

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const hms = (t) => new Date(t).toISOString().slice(11, 19); // @db.Time → wall clock
const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

async function main() {
  const [company] = await prisma.$queryRaw`SELECT "id", "name", "timeZone" FROM "Company" WHERE "id" = ${COMPANY_ID}`;
  if (!company) return console.log(`Company ${COMPANY_ID} not found.`);
  const tz = company.timeZone || "America/Los_Angeles";

  const days = await prisma.$queryRaw`
    SELECT d."leaveId", d."date", d."isPaid", d."hours", d."revertedAt",
           l."userId", l."leaveType", l."policyId", l."excludedShiftIds", l."requestedStartTime", l."requestedEndTime",
           p."firstName", p."lastName", u."email"
    FROM "LeaveDay" d
    JOIN "Leave" l ON l."id" = d."leaveId"
    JOIN "User" u ON u."id" = l."userId"
    LEFT JOIN "UserProfile" p ON p."userId" = u."id"
    WHERE u."companyId" = ${COMPANY_ID} AND l."status"::text = 'approved'
      AND d."date" >= ${FROM}::date AND d."date" <= ${TO}::date
    ORDER BY p."lastName", p."firstName", d."date"`;

  const nameOf = (r) => `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email;
  const filtered = NAME ? days.filter((d) => nameOf(d).toLowerCase().includes(NAME.toLowerCase())) : days;
  if (!filtered.length) return console.log(`\n${company.name}: no approved leave days ${FROM} → ${TO}${NAME ? ` for "${NAME}"` : ""}.`);

  const policyIds = [...new Set(filtered.map((d) => d.policyId || d.leaveType).filter(Boolean))];
  const policies = await prisma.$queryRaw`SELECT "id", "leaveType" FROM "LeavePolicy" WHERE "id" IN (${Prisma.join(policyIds.length ? policyIds : ["-"])})`;
  const policyName = new Map(policies.map((p) => [p.id, p.leaveType]));

  // Group LeaveDay rows by leave + date (a prorated day has a paid and an unpaid row).
  const groups = new Map();
  for (const d of filtered) {
    const k = `${d.leaveId}|${ymd(d.date)}`;
    if (!groups.has(k)) groups.set(k, { ...d, date: ymd(d.date), paidH: 0, unpaidH: 0, reverted: false });
    const g = groups.get(k);
    if (d.revertedAt) g.reverted = true;
    if (d.isPaid) g.paidH += n(d.hours);
    else g.unpaidH += n(d.hours);
  }

  const userIds = [...new Set(filtered.map((d) => d.userId))];
  const shifts = await prisma.$queryRaw`
    SELECT us."id", us."userId", us."assignedDate", us."customStartTime", us."customEndTime",
           s."shiftName", s."startTime", s."endTime", s."crossesMidnight", s."timeZone"
    FROM "UserShift" us JOIN "Shift" s ON s."id" = us."shiftId"
    WHERE us."userId" IN (${Prisma.join(userIds)}) AND us."status" <> 'cancelled'
      AND us."assignedDate" >= ${FROM}::date AND us."assignedDate" <= ${TO}::date`;
  const dayStart = moment.tz(FROM, tz).startOf("day").subtract(1, "day").toDate();
  const dayEnd = moment.tz(TO, tz).endOf("day").add(1, "day").toDate();
  const punches = await prisma.$queryRaw`
    SELECT t."id", t."userId", t."timeIn", t."timeOut", t."punchType"::text AS "punchType", t."netWorkedHours",
           t."driverAmSegmentHours", t."regularSegmentHours", t."driverPmSegmentHours",
           COALESCE(json_agg(a."status") FILTER (WHERE a."id" IS NOT NULL), '[]') AS "approvalStatuses"
    FROM "TimeLog" t LEFT JOIN "TimeLogApproval" a ON a."timeLogId" = t."id"
    WHERE t."userId" IN (${Prisma.join(userIds)}) AND t."timeIn" >= ${dayStart} AND t."timeIn" <= ${dayEnd}
    GROUP BY t."id"`;

  const counts = { FULL: 0, PARTIAL: 0, OVERLAP: 0, MISMATCH: 0, "NO SHIFT": 0, REVERTED: 0 };
  const lines = [];
  for (const g of groups.values()) {
    const excluded = new Set(Array.isArray(g.excludedShiftIds) ? g.excludedShiftIds : []);
    const dayShifts = shifts.filter((s) => s.userId === g.userId && ymd(s.assignedDate) === g.date);
    const win = (s) => {
      const zone = s.timeZone && moment.tz.zone(s.timeZone) ? s.timeZone : tz;
      const from = moment.tz(`${g.date} ${hms(s.customStartTime || s.startTime)}`, "YYYY-MM-DD HH:mm:ss", zone);
      let to = moment.tz(`${g.date} ${hms(s.customEndTime || s.endTime)}`, "YYYY-MM-DD HH:mm:ss", zone);
      if (s.crossesMidnight || !to.isAfter(from)) to = to.add(1, "day");
      return { name: s.shiftName, from, to, zone, hours: r2((to - from) / 36e5) };
    };
    const charged = dayShifts.filter((s) => !excluded.has(s.id)).map(win);
    const kept = dayShifts.filter((s) => excluded.has(s.id)).map(win);
    const dayPunches = punches.filter(
      (p) => p.userId === g.userId && moment(p.timeIn).tz(tz).format("YYYY-MM-DD") === g.date
    );
    const counted = dayPunches.filter((p) => !(p.approvalStatuses.length && p.approvalStatuses.every((s) => s === "excluded")));

    const cls = [];
    if (g.reverted) cls.push("REVERTED");
    if (!dayShifts.length) cls.push("NO SHIFT");
    if (!counted.length) cls.push("FULL");
    else cls.push("PARTIAL");
    const overlaps = counted.filter((p) => charged.some((w) => new Date(p.timeIn) < w.to.toDate() && (p.timeOut ? new Date(p.timeOut) : new Date()) > w.from.toDate()));
    if (overlaps.length) cls.push("OVERLAP");
    const leaveH = r2(g.paidH + g.unpaidH);
    const chargedH = r2(charged.reduce((t, w) => t + w.hours, 0));
    if (dayShifts.length && Math.abs(leaveH - chargedH) >= 0.01) cls.push("MISMATCH");
    cls.forEach((c) => (counts[c] = (counts[c] || 0) + 1));

    if (ONLY && !cls.some((c) => c.toLowerCase().replace(" ", "") === ONLY.toLowerCase())) continue;
    const fmtW = (w) => `${w.name} ${w.from.format("h:mm A")}–${w.to.format("h:mm A")}${w.zone !== tz ? ` (${w.zone})` : ""} ${w.hours}h`;
    const type = policyName.get(g.policyId || g.leaveType) || g.leaveType;
    lines.push(
      [
        `${nameOf(g)} | ${g.date} | ${type} | leave ${leaveH}h (paid ${r2(g.paidH)}, unpaid ${r2(g.unpaidH)}) | ${cls.join(", ")}`,
        `    charged: ${charged.length ? charged.map(fmtW).join("; ") : dayShifts.length ? "none (all shifts deselected)" : g.requestedStartTime ? `requested ${hms(g.requestedStartTime).slice(0, 5)}–${hms(g.requestedEndTime).slice(0, 5)}` : "whole day (default hours)"}${charged.length ? ` = ${chargedH}h` : ""}`,
        ...(kept.length ? [`    not on leave: ${kept.map(fmtW).join("; ")}`] : []),
        ...dayPunches.map((p) => {
          const segs = p.punchType.startsWith("DRIVER_AIDE")
            ? ` [AM ${p.driverAmSegmentHours ?? "—"} / Reg ${p.regularSegmentHours ?? "—"} / PM ${p.driverPmSegmentHours ?? "—"}]`
            : "";
          return `    punch: ${p.punchType} ${moment(p.timeIn).tz(tz).format("h:mm A")} → ${p.timeOut ? moment(p.timeOut).tz(tz).format("h:mm A") : "open"} net ${p.netWorkedHours ?? "—"}h${segs} | approvals: ${p.approvalStatuses.join(", ") || "none"}${overlaps.includes(p) ? " | OVERLAPS the leave" : ""}`;
        }),
      ].join("\n")
    );
  }

  console.log(`\n${company.name} (${tz}), approved leave days ${FROM} → ${TO}${NAME ? `, name contains "${NAME}"` : ""}${ONLY ? `, only ${ONLY}` : ""}\n`);
  lines.forEach((l) => console.log(l + "\n"));
  console.log(`Leave days: ${groups.size}. ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log("PARTIAL = punched on some shifts, leave on others (the case to show per shift in the Payroll Grid and request details).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
