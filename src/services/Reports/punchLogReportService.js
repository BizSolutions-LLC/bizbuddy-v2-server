// src/services/Reports/punchLogReportService.js
//
// BB-119 steps 8 + 9 (docs/changelog-v2.11.7.md): ONE builder for the
// employee "My Punch Logs" and the company "Employee Punch Logs" reports, so the
// same punch always shows the same hours, OT and cutoff status for both.
//
// READ-ONLY: this module never writes. It never calls getCutoffApprovals (which
// can auto-sync, backfill, refresh fixed hours and auto-resolve leave conflicts);
// it reads the same tables itself. Logic copied for that purpose is marked
// "mirrors <file>:<function>" — keep them in step until they're folded together.
//
// Sources, picked per cutoff period (same rule the company page used):
//   - locked / processed cutoff → REVIEWED: TimeLogApproval payable hours
//     (approved/resolved only; excluded = 0), the cutoff's OT blocks, fixed hours;
//   - open cutoff, or a plain date range → LIVE: the TimeLog computed fields
//     (timeLogComputeService), approved clock times, OT per the rule below.
// Data basis → "final" (all reviewed), "preliminary" (all live) or "partial".
//
// OT rule (no new maths — what the server already records):
//   - B&C: CutoffOtBlock per employee per day (hours + Approved/Pending/Excluded);
//   - Daycare, otBasis "cutoff": OT is hours above the company's cutoff threshold
//     (e.g. 80h) for the WHOLE cutoff — one CutoffOtBlock per employee per period.
//     It isn't per day, so rows show no OT; the report lists it per cutoff
//     (report.cutoffOt) and per employee instead;
//   - Daycare, daily/weekly: the punch's OT requests — "Approved" / "Pending",
//     else "Not requested" when rawOtMinutes > 0, else "—".
//
// Scope: scope=mine → the requester's own punches; scope=team → admin/superadmin
// the whole company, supervisor their department + direct reports. B. Buddy is
// never listed (HUMAN_ONLY).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { BNC_COMPANY_IDS } = require("@config/companyTypes");
const { getFixedHoursForCutoff, getOffDayTimeLogIds } = require("@services/Cutoff/fixedHoursService");
const { resolveRequester } = require("@services/Reports/reportRequester");

const DEFAULT_TZ = "America/Los_Angeles";
const MAX_RANGE_DAYS = 400;
const PUNCH_TYPES = ["REGULAR", "TRAINING", "DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"];
const DA_TYPES = new Set(["DRIVER_AIDE", "DRIVER_AIDE_AM", "DRIVER_AIDE_PM"]);
const PUNCH_LABEL = {
  REGULAR: "Regular",
  TRAINING: "Training",
  DRIVER_AIDE: "Driver/Aide",
  DRIVER_AIDE_AM: "Driver/Aide AM",
  DRIVER_AIDE_PM: "Driver/Aide PM",
};
const FINAL_STATUSES = new Set(["locked", "processed"]);

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v) => (v == null ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && moment.utc(s, "YYYY-MM-DD", true).isValid();
const parseList = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);
const calYmd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const personName = (u) => `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim() || u?.email || "Unknown";
// A reviewed clock time counts as "adjusted" only when it differs from the punch by a minute or more.
const moved = (approved, raw) => !!approved && (!raw || Math.abs(new Date(approved) - new Date(raw)) >= 60000);
// "Last, First" for table columns; falls back to the full name or email when one part is missing.
const listNameOf = (u) => {
  const first = (u?.profile?.firstName || "").trim();
  const last = (u?.profile?.lastName || "").trim();
  return first && last ? `${last}, ${first}` : personName(u);
};
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const breakMinutes = (b) => (b?.start && b?.end ? Math.max(0, (new Date(b.end) - new Date(b.start)) / 60000) : 0);
const coffeeMinutesOf = (tl) =>
  tl.totalBreakMinutes != null ? tl.totalBreakMinutes : (Array.isArray(tl.coffeeBreaks) ? tl.coffeeBreaks : []).reduce((t, b) => t + breakMinutes(b), 0);
// mirrors EmployeesPunchLogs.jsx:enrichTimelogs — a stored deduction wins when no lunch was punched.
const lunchMinutesOf = (tl) =>
  !tl.lunchBreak?.start && (tl.lunchDeductionMinutes ?? 0) > 0 ? tl.lunchDeductionMinutes : breakMinutes(tl.lunchBreak);
// Lunch window for the detail export: punched times, or "auto" when the lunch was deducted without a punch.
const lunchWindowOf = (tl) =>
  !tl.lunchBreak?.start && (tl.lunchDeductionMinutes ?? 0) > 0
    ? { lunchStart: null, lunchEnd: null, lunchAuto: true }
    : { lunchStart: tl.lunchBreak?.start || null, lunchEnd: tl.lunchBreak?.end || null, lunchAuto: false };
// mirrors EmployeesPunchLogs.jsx:fmtDevice / fmtLoc — device "Brand, Model"; location "lat, lng".
const deviceText = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d;
  return [d.manufacturer || d.brand, d.deviceName || d.model].filter(Boolean).join(", ") || null;
};
const locationText = (loc) =>
  loc && loc.latitude != null && loc.longitude != null ? `${Number(loc.latitude).toFixed(5)}, ${Number(loc.longitude).toFixed(5)}` : null;
// Device / location / lunch / gross details shared by both sources.
const detailOf = (tl) => ({
  gross: num(tl.grossHours),
  deviceIn: deviceText(tl.deviceInfo?.start),
  deviceOut: deviceText(tl.deviceInfo?.end),
  locationIn: locationText(tl.location?.start),
  locationOut: locationText(tl.location?.end),
  ...lunchWindowOf(tl),
});

// ── Approval helpers — mirror timeLogController.js (dedupApprovalsBySegment,
//    computeDayCutoffStatus, pickApprovedClockTime). ──────────────────────────
function dedupApprovalsBySegment(approvals) {
  const best = new Map();
  for (const a of approvals ?? []) {
    const key = a.segmentType ?? "__none__";
    const existing = best.get(key);
    if (!existing || (existing.status === "pending" && a.status !== "pending")) best.set(key, a);
  }
  return [...best.values()];
}
const IN_PRIORITY = ["driver_am", "regular", "driver_pm", "__none__"];
const OUT_PRIORITY = ["driver_pm", "regular", "driver_am", "__none__"];
function pickApprovedClockTime(deduped, priority, field) {
  const bySeg = new Map(deduped.map((a) => [a.segmentType ?? "__none__", a]));
  for (const key of priority) {
    const a = bySeg.get(key);
    if (a && a.status === "approved" && a[field] != null) return a[field];
  }
  return null;
}
// Day-level review state for the "Cutoff status" column.
function cutoffStatusOf(statuses) {
  if (!statuses.length) return "Not in a cutoff";
  if (statuses.some((s) => s === "pending")) return "Pending review";
  if (statuses.every((s) => s === "excluded" || s === "rejected")) return "Excluded";
  return "Approved";
}

// mirrors cutoffPeriodController.js:enrichApprovals — payable hours of one approval
// (segment-aware for Driver/Aide; approved actualHours wins; pending → stored value).
function payableHoursOf(approval) {
  const tl = approval.timeLog;
  const seg = approval.segmentType ?? null;
  const approvedActual = approval.status === "approved" && approval.actualHours != null ? Number(approval.actualHours) : null;
  if (tl.punchType === "DRIVER_AIDE" && seg) {
    const windowHours =
      approval.segmentStart && approval.segmentEnd ? (new Date(approval.segmentEnd) - new Date(approval.segmentStart)) / 3600000 : null;
    let approvedHours = approvedActual;
    if (approvedHours == null && approval.status === "approved" && approval.approvedClockIn && approval.approvedClockOut) {
      const segStart = approval.segmentStart ? new Date(approval.segmentStart).getTime() : -Infinity;
      if (new Date(approval.approvedClockIn).getTime() >= segStart) {
        approvedHours = (new Date(approval.approvedClockOut) - new Date(approval.approvedClockIn)) / 3600000;
      }
    }
    const stored = num(seg === "driver_am" ? tl.driverAmSegmentHours : seg === "regular" ? tl.regularSegmentHours : tl.driverPmSegmentHours);
    return { hours: approvedHours ?? stored ?? windowHours ?? 0, scheduled: windowHours ?? stored };
  }
  return { hours: approvedActual ?? num(tl.netWorkedHours) ?? num(tl.grossHours) ?? 0, scheduled: num(tl.scheduledHours) };
}

// ── Scope ───────────────────────────────────────────────────────────────────
async function resolveUsers(actor, me, f) {
  if (f.scope === "mine") {
    return prisma.user.findMany({ where: { id: actor.id }, select: USER_SELECT });
  }
  const where = { ...HUMAN_ONLY, companyId: actor.companyId };
  if (actor.role === "supervisor") {
    where.OR = [{ employmentDetail: { supervisorId: actor.id } }, ...(me?.departmentId ? [{ departmentId: me.departmentId }] : [])];
  }
  if (f.departmentId) where.departmentId = f.departmentId;
  if (f.employeeIds.length) where.id = { in: f.employeeIds };
  return prisma.user.findMany({ where, select: USER_SELECT });
}
const USER_SELECT = {
  id: true,
  email: true,
  employeeId: true,
  departmentId: true,
  department: { select: { name: true } },
  profile: { select: { firstName: true, lastName: true } },
  employmentDetail: { select: { jobTitle: true } },
};

// ── LIVE source ─────────────────────────────────────────────────────────────
async function loadLive({ company, tz, from, to, userIds, f, isBnC }) {
  if (!userIds.length) return [];
  const where = {
    userId: { in: userIds },
    timeIn: { gte: moment.tz(from, tz).startOf("day").toDate(), lte: moment.tz(to, tz).endOf("day").toDate() },
    ...(f.punchType && { punchType: f.punchType }),
    ...(f.status === "active" && { status: true }),
    ...(f.status === "completed" && { status: false }),
  };
  const logs = await prisma.timeLog.findMany({
    where,
    orderBy: { timeIn: "asc" },
    select: {
      id: true, userId: true, timeIn: true, timeOut: true, status: true, punchType: true,
      coffeeBreaks: true, lunchBreak: true, lunchDeductionMinutes: true, totalBreakMinutes: true,
      netWorkedHours: true, grossHours: true, scheduledHours: true, lateHours: true, undertimeHours: true,
      deviceInfo: true, location: true,
      rawOtMinutes: true, regularSegmentHours: true, driverAmSegmentHours: true, driverPmSegmentHours: true,
      overtime: { select: { status: true, requestedHours: true } },
      approvals: {
        select: { status: true, segmentType: true, approvedClockIn: true, approvedClockOut: true, cutoffPeriodId: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // OT blocks: B&C per day. (Cutoff-basis OT is per period — see buildCutoffOt.)
  let blockByDay = new Map();
  if (isBnC && logs.length) {
    const blocks = await prisma.cutoffOtBlock.findMany({
      where: { userId: { in: userIds }, date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
      select: { userId: true, date: true, otHours: true, status: true },
    });
    blockByDay = new Map(blocks.map((b) => [`${b.userId}|${calYmd(b.date)}`, b]));
  }

  return logs.map((tl) => {
    const date = moment(tl.timeIn).tz(tz).format("YYYY-MM-DD");
    const deduped = dedupApprovalsBySegment(tl.approvals);
    const approvedIn = pickApprovedClockTime(deduped, IN_PRIORITY, "approvedClockIn");
    const approvedOut = pickApprovedClockTime(deduped, OUT_PRIORITY, "approvedClockOut");
    const isDA = DA_TYPES.has(tl.punchType);
    const am = isDA && !isBnC ? num(tl.driverAmSegmentHours) : null;
    const reg = isDA && !isBnC ? num(tl.regularSegmentHours) : null;
    const pm = isDA && !isBnC ? num(tl.driverPmSegmentHours) : null;
    // mirrors EmployeesPunchLogs.jsx:enrichTimelogs — DA total only when all three segments exist.
    const daTotal = isDA && am != null && reg != null && pm != null ? am + reg + pm : null;
    const worked =
      tl.netWorkedHours != null ? (daTotal ?? Number(tl.netWorkedHours)) : tl.grossHours != null ? Number(tl.grossHours) : tl.timeOut ? (new Date(tl.timeOut) - new Date(tl.timeIn)) / 3600000 : 0;

    // ── OT ──
    let otHours = 0;
    let otStatus = "—";
    const raw = (tl.rawOtMinutes || 0) / 60;
    if (isBnC) {
      const b = blockByDay.get(`${tl.userId}|${date}`);
      if (b) {
        otHours = Number(b.otHours);
        otStatus = cap(b.status);
      }
    } else if (company.otBasis === "cutoff") {
      otHours = null; // counted per cutoff, not per punch
    } else {
      const approved = tl.overtime.filter((o) => o.status === "approved").reduce((t, o) => t + (Number(o.requestedHours) || 0), 0);
      const pending = tl.overtime.some((o) => o.status === "pending");
      otHours = approved > 0 ? approved : raw;
      otStatus = approved > 0 ? "Approved" : pending ? "Pending" : raw > 0 ? "Not requested" : "—";
    }

    return {
      userId: tl.userId,
      date,
      clockIn: approvedIn || tl.timeIn,
      clockOut: approvedOut || tl.timeOut,
      clockAdjusted: moved(approvedIn, tl.timeIn) || moved(approvedOut, tl.timeOut),
      punchType: tl.punchType || "REGULAR",
      worked: r2(worked),
      am: r2(am),
      regular: r2(reg),
      pm: r2(pm),
      scheduled: r2(tl.scheduledHours),
      late: r2(tl.lateHours) ?? 0,
      undertime: r2(tl.undertimeHours) ?? 0,
      coffeeMinutes: Math.round(coffeeMinutesOf(tl)),
      lunchMinutes: Math.round(lunchMinutesOf(tl)),
      otHours: r2(otHours),
      otStatus,
      cutoffStatus: cutoffStatusOf(deduped.map((a) => a.status)),
      active: tl.status === true,
      isScheduled: tl.scheduledHours != null, // a shift was assigned that day
      ...detailOf(tl),
      gross: r2(tl.grossHours),
      basis: "live",
    };
  });
}

// ── REVIEWED source (locked / processed cutoff) ─────────────────────────────
// mirrors cutoffPeriodController.js:getCutoffApprovals (read parts only) and the
// client's buildRowsFromApprovals: one row per employee per day; payable hours
// count only for approved/resolved approvals.
async function loadReviewed({ company, tz, period, userIds, f, isBnC }) {
  if (!userIds.length) return { rows: [], fixedHours: [], otBlocks: [] };
  const approvals = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId: period.id,
      timeLog: { userId: { in: userIds }, ...(f.punchType && { punchType: f.punchType }) },
    },
    orderBy: { timeLog: { timeIn: "asc" } },
    select: {
      status: true, segmentType: true, actualHours: true, approvedClockIn: true, approvedClockOut: true,
      segmentStart: true, segmentEnd: true, timeLogId: true,
      timeLog: {
        select: {
          id: true, userId: true, timeIn: true, timeOut: true, punchType: true,
          coffeeBreaks: true, lunchBreak: true, lunchDeductionMinutes: true, totalBreakMinutes: true,
          netWorkedHours: true, grossHours: true, scheduledHours: true, lateHours: true, undertimeHours: true,
          deviceInfo: true, location: true,
          regularSegmentHours: true, driverAmSegmentHours: true, driverPmSegmentHours: true,
          overtime: { where: { status: "approved" }, select: { requestedHours: true } },
        },
      },
    },
  });

  const [fixedRows, otBlocks] = await Promise.all([
    getFixedHoursForCutoff(period),
    prisma.cutoffOtBlock.findMany({
      where: { cutoffPeriodId: period.id, userId: { in: userIds } },
      select: { userId: true, date: true, otHours: true, status: true },
    }),
  ]);
  const fixedUserIds = new Set(fixedRows.map((r) => r.userId));
  const offDayIds = fixedUserIds.size ? await getOffDayTimeLogIds(period, [...fixedUserIds]) : new Set();
  const blockByDay = new Map(otBlocks.map((b) => [`${b.userId}|${calYmd(b.date)}`, b]));

  const groups = new Map();
  const seenLogs = new Set();
  for (const a of approvals) {
    const tl = a.timeLog;
    if (!tl) continue;
    const date = moment(tl.timeIn).tz(tz).format("YYYY-MM-DD");
    const key = `${tl.userId}|${date}`;
    if (!groups.has(key)) {
      groups.set(key, {
        userId: tl.userId, date, clockIn: null, clockOut: null, firstIn: tl.timeIn, lastOut: tl.timeOut,
        punchType: tl.punchType || "REGULAR", worked: 0, am: null, regular: null, pm: null, scheduled: null,
        late: 0, undertime: 0, coffeeMinutes: 0, lunchMinutes: 0, approvedOt: 0, statuses: [],
        fixedHoursScheduledHours: 0, isOffDay: false, isFixedHours: fixedUserIds.has(tl.userId),
        gross: null, firstLog: tl, lastLog: tl, lunchLog: null,
      });
    }
    const g = groups.get(key);
    g.statuses.push(a.status);
    if (offDayIds.has(a.timeLogId)) g.isOffDay = true;
    if (tl.timeOut && (!g.lastOut || tl.timeOut > g.lastOut)) g.lastOut = tl.timeOut;
    if (tl.timeIn < g.firstIn) g.firstIn = tl.timeIn;
    if (a.status === "approved" && a.approvedClockIn && (!g.clockIn || a.approvedClockIn < g.clockIn)) g.clockIn = a.approvedClockIn;
    if (a.status === "approved" && a.approvedClockOut && (!g.clockOut || a.approvedClockOut > g.clockOut)) g.clockOut = a.approvedClockOut;

    const { hours, scheduled } = payableHoursOf(a);
    const counted = a.status === "approved" || a.status === "resolved";
    const payable = counted ? hours : 0;
    // BB-089: fixed-hours employees' scheduled-day punches are excluded (flat hours cover them)
    if (g.isFixedHours && !offDayIds.has(a.timeLogId) && a.status === "excluded") g.fixedHoursScheduledHours += hours;
    if (scheduled != null) g.scheduled = (g.scheduled ?? 0) + scheduled;

    if (a.segmentType) {
      g.punchType = "DRIVER_AIDE";
      if (a.segmentType === "driver_am") g.am = (g.am ?? 0) + payable;
      if (a.segmentType === "regular") g.regular = (g.regular ?? 0) + payable;
      if (a.segmentType === "driver_pm") g.pm = (g.pm ?? 0) + payable;
    } else {
      g.worked += payable;
      if (tl.punchType === "TRAINING") g.punchType = "TRAINING";
      else if (g.punchType !== "TRAINING" && g.punchType !== "DRIVER_AIDE") g.punchType = tl.punchType || "REGULAR";
    }
    if (!seenLogs.has(tl.id)) {
      seenLogs.add(tl.id);
      g.late += Number(tl.lateHours || 0);
      g.undertime += Number(tl.undertimeHours || 0);
      g.coffeeMinutes += coffeeMinutesOf(tl);
      g.lunchMinutes += lunchMinutesOf(tl);
      if (tl.grossHours != null) g.gross = (g.gross ?? 0) + Number(tl.grossHours);
      if (tl.timeIn < g.firstLog.timeIn) g.firstLog = tl;
      if ((tl.timeOut || tl.timeIn) > (g.lastLog.timeOut || g.lastLog.timeIn)) g.lastLog = tl;
      if (!g.lunchLog && (tl.lunchBreak?.start || (tl.lunchDeductionMinutes ?? 0) > 0)) g.lunchLog = tl;
      if (counted) g.approvedOt += (tl.overtime || []).reduce((t, o) => t + (Number(o.requestedHours) || 0), 0);
    }
  }

  const rows = [...groups.values()].map((g) => {
    const isDA = g.punchType === "DRIVER_AIDE";
    const worked = isDA ? (g.am || 0) + (g.regular || 0) + (g.pm || 0) : g.worked;
    let otHours = 0;
    let otStatus = "—";
    if (isBnC) {
      const b = blockByDay.get(`${g.userId}|${g.date}`);
      if (b) {
        otHours = Number(b.otHours);
        otStatus = cap(b.status);
      }
    } else if (company.otBasis === "cutoff") {
      otHours = null; // counted per cutoff, not per day
    } else if (g.approvedOt > 0) {
      otHours = g.approvedOt;
      otStatus = "Approved";
    }
    return {
      userId: g.userId,
      date: g.date,
      clockIn: g.clockIn || g.firstIn,
      clockOut: g.clockOut || g.lastOut,
      clockAdjusted: moved(g.clockIn, g.firstIn) || moved(g.clockOut, g.lastOut),
      punchType: g.punchType,
      worked: r2(worked),
      am: r2(g.am),
      regular: r2(g.regular),
      pm: r2(g.pm),
      scheduled: r2(g.scheduled),
      late: r2(g.late),
      undertime: r2(g.undertime),
      coffeeMinutes: Math.round(g.coffeeMinutes),
      lunchMinutes: Math.round(g.lunchMinutes),
      otHours: r2(otHours),
      otStatus,
      cutoffStatus: cutoffStatusOf(g.statuses),
      active: false,
      isScheduled: g.scheduled != null,
      gross: r2(g.gross),
      deviceIn: deviceText(g.firstLog.deviceInfo?.start),
      deviceOut: deviceText(g.lastLog.deviceInfo?.end),
      locationIn: locationText(g.firstLog.location?.start),
      locationOut: locationText(g.lastLog.location?.end),
      ...(g.lunchLog ? lunchWindowOf(g.lunchLog) : { lunchStart: null, lunchEnd: null, lunchAuto: false }),
      basis: "reviewed",
      isFixedHours: g.isFixedHours,
      isOffDay: g.isOffDay,
      fixedHoursScheduledHours: r2(g.fixedHoursScheduledHours),
      cutoffPeriodId: period.id,
    };
  });

  return {
    rows,
    fixedHours: fixedRows.filter((r) => userIds.includes(r.userId)).map((r) => ({ ...r, cutoffPeriodId: period.id })),
    otBlocks: otBlocks.map((b) => ({ ...b, date: calYmd(b.date), otHours: Number(b.otHours), cutoffPeriodId: period.id })),
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────
/**
 * @param {{ id, role, companyId, agentId? }} actor  req.user
 * @param {{ scope?, from?, to?, cutoffPeriodIds?, departmentId?, employeeIds?, punchType?, status? }} query
 */
async function buildPunchLogReport(actor, query = {}) {
  const f = {
    scope: query.scope === "team" ? "team" : "mine",
    from: query.from || null,
    to: query.to || null,
    cutoffPeriodIds: parseList(query.cutoffPeriodIds),
    departmentId: query.departmentId || null,
    employeeIds: parseList(query.employeeIds),
    punchType: query.punchType && query.punchType !== "all" ? query.punchType : null,
    status: ["active", "completed"].includes(query.status) ? query.status : null,
  };
  if (f.scope === "team" && !["admin", "superadmin", "supervisor"].includes(actor.role))
    throw new ReportError(403, "Only admins and supervisors can report on other employees' punches.");
  if (f.punchType && !PUNCH_TYPES.includes(f.punchType)) throw new ReportError(400, `punchType must be one of: all, ${PUNCH_TYPES.join(", ")}`);
  if (f.from && !isYmd(f.from)) throw new ReportError(400, "from must be YYYY-MM-DD");
  if (f.to && !isYmd(f.to)) throw new ReportError(400, "to must be YYYY-MM-DD");
  if (!f.cutoffPeriodIds.length) {
    if (!f.from || !f.to) throw new ReportError(400, "Choose a date range (from and to) or one or more cutoff periods.");
    if (f.from > f.to) throw new ReportError(400, "from must not be after to");
    if (moment.utc(f.to).diff(moment.utc(f.from), "days") > MAX_RANGE_DAYS) throw new ReportError(400, `The range can't be longer than ${MAX_RANGE_DAYS} days.`);
  }

  const [company, me] = await Promise.all([
    prisma.company.findUnique({
      where: { id: actor.companyId },
      select: { name: true, timeZone: true, otBasis: true, dailyOtThresholdHours: true, weeklyOtThresholdHours: true, cutoffOtThresholdHours: true, defaultShiftHours: true },
    }),
    prisma.user.findUnique({ where: { id: actor.id }, select: { email: true, isSystemAgent: true, departmentId: true, profile: { select: { firstName: true, lastName: true } } } }),
  ]);
  if (!company) throw new ReportError(404, "Company not found.");
  const tz = company.timeZone || DEFAULT_TZ;
  const isBnC = BNC_COMPANY_IDS.has(actor.companyId);

  const users = await resolveUsers(actor, me, f);
  const userById = new Map(users.map((u) => [u.id, u]));
  const allIds = users.map((u) => u.id);

  let rows = [];
  let fixedHours = [];
  let otBlocks = [];
  const periods = [];

  if (f.cutoffPeriodIds.length) {
    const found = await prisma.cutoffPeriod.findMany({
      where: { id: { in: f.cutoffPeriodIds }, OR: [{ companyId: actor.companyId }, { creator: { companyId: actor.companyId } }] },
      select: { id: true, companyId: true, departmentId: true, periodStart: true, periodEnd: true, status: true, department: { select: { name: true } } },
    });
    if (found.length !== new Set(f.cutoffPeriodIds).size) throw new ReportError(404, "One or more cutoff periods weren't found.");
    for (const p of found.sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))) {
      const ids = p.departmentId ? allIds.filter((id) => userById.get(id)?.departmentId === p.departmentId) : allIds;
      const start = calYmd(p.periodStart);
      const end = calYmd(p.periodEnd);
      const reviewed = FINAL_STATUSES.has(p.status);
      periods.push({ id: p.id, start, end, status: p.status, department: p.department?.name || null, reviewed });
      if (reviewed) {
        const r = await loadReviewed({ company, tz, period: { ...p, companyId: p.companyId || actor.companyId }, userIds: ids, f, isBnC });
        rows.push(...r.rows);
        fixedHours.push(...r.fixedHours);
        otBlocks.push(...r.otBlocks);
      } else {
        rows.push(...(await loadLive({ company, tz, from: start, to: end, userIds: ids, f, isBnC })));
      }
    }
    // Live filter by status (active/completed) doesn't apply to reviewed rows; reviewed days are all completed.
    if (f.status === "active") rows = rows.filter((r) => r.active);
  } else {
    rows = await loadLive({ company, tz, from: f.from, to: f.to, userIds: allIds, f, isBnC });
  }

  // "Location required": employees with an active location restriction (mirrors the page's locMap).
  const restricted = allIds.length
    ? new Set(
        (await prisma.locationRestriction.findMany({ where: { userId: { in: allIds }, restrictionStatus: true }, select: { userId: true } })).map((x) => x.userId)
      )
    : new Set();

  // Attach people and sort: last name, first name, date.
  rows = rows
    .map((r) => {
      const u = userById.get(r.userId);
      return {
        ...r,
        employeeName: personName(u),
        listName: listNameOf(u), // "Last, First" for table columns
        firstName: u?.profile?.firstName || "",
        lastName: u?.profile?.lastName || "",
        employeeId: u?.employeeId || null,
        email: u?.email || null,
        department: u?.department?.name || null,
        jobTitle: u?.employmentDetail?.jobTitle || null,
        punchLabel: PUNCH_LABEL[r.punchType] || r.punchType,
        locationRequired: restricted.has(r.userId),
      };
    })
    .sort(
      (a, b) =>
        (a.lastName || a.employeeName).localeCompare(b.lastName || b.employeeName) ||
        a.firstName.localeCompare(b.firstName) ||
        a.date.localeCompare(b.date) ||
        new Date(a.clockIn) - new Date(b.clockIn)
    );

  // ── Cutoff-basis OT (Daycare "cutoff"): one figure per employee per cutoff ──
  const cutoffBasis = !isBnC && company.otBasis === "cutoff";
  let cutoffOt = [];
  if (cutoffBasis && periods.length && allIds.length) {
    const blocks = await prisma.cutoffOtBlock.findMany({
      where: { cutoffPeriodId: { in: periods.map((p) => p.id) }, userId: { in: allIds } },
      select: { userId: true, cutoffPeriodId: true, otHours: true, status: true },
    });
    const periodById = new Map(periods.map((p) => [p.id, p]));
    cutoffOt = blocks
      .map((b) => {
        const u = userById.get(b.userId);
        const p = periodById.get(b.cutoffPeriodId);
        return {
          userId: b.userId,
          employeeName: personName(u),
          listName: listNameOf(u),
          cutoffPeriodId: b.cutoffPeriodId,
          periodStart: p?.start || null,
          periodEnd: p?.end || null,
          otHours: r2(b.otHours),
          status: cap(b.status), // Pending / Approved / Excluded
        };
      })
      .sort((a, b) => a.listName.localeCompare(b.listName) || String(a.periodStart).localeCompare(String(b.periodStart)));
  }
  // Paid or still to be decided; excluded OT isn't paid.
  const countedOt = (list) => r2(list.filter((x) => x.status !== "Excluded").reduce((t, x) => t + (Number(x.otHours) || 0), 0));
  const otStatusOf = (list) =>
    !list.length ? null : list.some((x) => x.status === "Pending") ? "Pending" : list.every((x) => x.status === "Excluded") ? "Excluded" : "Approved";

  // ── Data basis ──
  const anyReviewed = periods.some((p) => p.reviewed);
  const anyLive = !periods.length || periods.some((p) => !p.reviewed);
  const basis = anyReviewed && !anyLive ? "final" : anyReviewed ? "partial" : "preliminary";

  // ── Summary + by employee ──
  const sum = (list, k) => r2(list.reduce((t, r) => t + (Number(r[k]) || 0), 0));
  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.userId)) byEmp.set(r.userId, { userId: r.userId, employeeName: r.employeeName, listName: r.listName, rows: [] });
    byEmp.get(r.userId).rows.push(r);
  }
  const byEmployee = [...byEmp.values()].map((e) => ({
    userId: e.userId,
    employeeName: e.employeeName,
    listName: e.listName,
    days: new Set(e.rows.map((r) => r.date)).size,
    records: e.rows.length,
    worked: sum(e.rows, "worked"),
    scheduled: sum(e.rows, "scheduled"),
    otHours: cutoffBasis ? countedOt(cutoffOt.filter((x) => x.userId === e.userId)) : sum(e.rows, "otHours"),
    otStatus: cutoffBasis ? otStatusOf(cutoffOt.filter((x) => x.userId === e.userId)) : null,
    late: sum(e.rows, "late"),
    fixedHours: r2(fixedHours.filter((x) => x.userId === e.userId).reduce((t, x) => t + (Number(x.hours) || 0), 0)) || null,
    isFixedHours: fixedHours.some((x) => x.userId === e.userId),
  }));
  // BB-089: a fixed-hours employee with no punches in range is still paid their fixed hours — list them too.
  for (const userId of new Set(fixedHours.map((x) => x.userId))) {
    if (byEmp.has(userId) || !userById.has(userId)) continue;
    const u = userById.get(userId);
    byEmployee.push({
      userId, employeeName: personName(u), listName: listNameOf(u), days: 0, records: 0, worked: 0, scheduled: 0,
      otHours: cutoffBasis ? countedOt(cutoffOt.filter((x) => x.userId === userId)) : 0,
      otStatus: cutoffBasis ? otStatusOf(cutoffOt.filter((x) => x.userId === userId)) : null,
      late: 0,
      fixedHours: r2(fixedHours.filter((x) => x.userId === userId).reduce((t, x) => t + (Number(x.hours) || 0), 0)),
      isFixedHours: true,
    });
  }
  byEmployee.sort((a, b) => a.listName.localeCompare(b.listName));
  const hasDriverAide = rows.some((r) => DA_TYPES.has(r.punchType) || r.am != null || r.pm != null);
  const fmt = (ymd) => moment(ymd, "YYYY-MM-DD").format("MM-DD-YYYY");
  const rangeFrom = periods.length ? periods.map((p) => p.start).sort()[0] : f.from;
  const rangeTo = periods.length ? periods.map((p) => p.end).sort().slice(-1)[0] : f.to;

  return {
    company: {
      name: company.name,
      timeZone: tz,
      isBnC,
      otBasis: company.otBasis || "daily",
      // The company's OT Configuration threshold for its basis (hours per day / week / cutoff).
      otThreshold: Number(
        (company.otBasis === "cutoff" ? company.cutoffOtThresholdHours : company.otBasis === "weekly" ? company.weeklyOtThresholdHours : company.dailyOtThresholdHours) ??
          (company.otBasis === "cutoff" ? 80 : company.otBasis === "weekly" ? 40 : 8)
      ),
      defaultShiftHours: Number(company.defaultShiftHours ?? 8),
    },
    requester: await resolveRequester(actor, me),
    scope: f.scope === "mine" ? { label: "Your punches", team: false } : actor.role === "supervisor" ? { label: "Your team", team: true } : { label: "Whole company", team: true },
    filters: {
      ...f,
      rangeFrom,
      rangeTo,
      rangeLabel: `${fmt(rangeFrom)} – ${fmt(rangeTo)}`,
      punchLabel: f.punchType ? PUNCH_LABEL[f.punchType] : "All punch types",
      statusLabel: f.status === "active" ? "Active only" : f.status === "completed" ? "Completed only" : "All punches",
    },
    periods,
    basis,
    generatedAt: moment().tz(tz),
    rows,
    byEmployee,
    fixedHours,
    otBlocks,
    cutoffOt, // cutoff-basis OT per employee per cutoff ([] otherwise)
    cutoffBasis,
    hasDriverAide,
    summary: {
      employees: byEmployee.length,
      days: rows.length ? new Set(rows.map((r) => `${r.userId}|${r.date}`)).size : 0,
      records: rows.length,
      worked: sum(rows, "worked"),
      scheduled: sum(rows, "scheduled"),
      otHours: cutoffBasis ? (periods.length ? countedOt(cutoffOt) : null) : sum(rows, "otHours"),
      late: sum(rows, "late"),
      pendingReview: rows.filter((r) => r.cutoffStatus === "Pending review").length,
      active: rows.filter((r) => r.active).length,
      completed: rows.filter((r) => !r.active).length,
      scheduledRecords: rows.filter((r) => r.isScheduled).length,
      gross: sum(rows, "gross"),
    },
  };
}

// ── Details CSV ─────────────────────────────────────────────────────────────
const BASIS_LABEL = { reviewed: "Reviewed (locked cutoff)", live: "Live (not yet reviewed)" };

const csvHeaders = (report) => {
  const z = report.company.timeZone;
  return [
    "Last name", "First name", "Employee ID", "Email", "Department", `Date (${z})`, `Clock in (${z})`, `Clock out (${z})`,
    "Clock times adjusted in review", "Status", "Punch type", "Scheduled", "Worked hours", "Gross hours",
    "Driver/Aide AM", "Regular", "Driver/Aide PM", "Scheduled hours", "OT hours", "OT status", "Late hours", "Undertime hours",
    "Coffee minutes", "Lunch minutes", `Lunch start (${z})`, `Lunch end (${z})`, "Cutoff status", "Data basis",
    "Location required", "Check-in location", "Check-out location", "Device in", "Device out",
  ];
};

function punchLogsCsvRows(report) {
  const z = report.company.timeZone;
  const stamp = (d) => (d ? moment(d).tz(z).format("YYYY-MM-DD HH:mm") : null);
  const clock = (d) => (d ? moment(d).tz(z).format("HH:mm") : null);
  // Cutoff-basis OT is per cutoff, not per row — left blank here (see the Excel/PDF "Overtime by cutoff").
  return report.rows.map((r) => [
    r.lastName || (!r.firstName ? r.employeeName : null), r.firstName, r.employeeId, r.email, r.department, r.date,
    stamp(r.clockIn), stamp(r.clockOut), r.clockAdjusted ? "Yes" : "No", r.active ? "Active" : "Completed",
    r.punchLabel, r.isScheduled ? "Scheduled" : "Unscheduled", r.worked, r.gross,
    r.am, r.regular, r.pm, r.scheduled, r.otHours, r.otStatus === "—" ? null : r.otStatus, r.late, r.undertime,
    r.coffeeMinutes, r.lunchMinutes, r.lunchAuto ? "Auto-deducted" : clock(r.lunchStart), r.lunchAuto ? "Auto-deducted" : clock(r.lunchEnd),
    r.cutoffStatus, BASIS_LABEL[r.basis], r.locationRequired ? "Required" : "None",
    r.locationIn, r.locationOut, r.deviceIn, r.deviceOut,
  ]);
}

const reportFileName = (report, ext, kind = "PunchLogs") =>
  `BizBuddy_${kind}_${report.requester.fileName}_${report.filters.rangeFrom}_${report.filters.rangeTo}_${report.generatedAt.format("YYYY-MM-DD_HH-mm")}.${ext}`;

module.exports = { buildPunchLogReport, punchLogsCsvRows, csvHeaders, reportFileName, ReportError, PUNCH_LABEL, BASIS_LABEL };
