// src/services/attendanceReportSchedule.js
//
// BB-117: when a company's morning / evening attendance email is due.
// The cron checks every 5 minutes; each company gets its report at its own
// Notification Settings time (Company.morningReportTime / eveningReportTime,
// "HH:mm", default 10:00 / 18:00) in its own time zone, once per day.
//
// "Once per day" is claimed in the database (Company.morningReportSentOn /
// eveningReportSentOn = the company-zone date): an updateMany that only matches
// when the date isn't today yet, so two server processes can't both send.
// A report is only sent within LATE_LIMIT_HOURS of its time, so a server that
// was down all day doesn't send a stale "morning" report at night.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");

const DEFAULT_TZ = "America/Los_Angeles";
const LATE_LIMIT_HOURS = 3;

const KINDS = {
  morning: { timeField: "morningReportTime", sentField: "morningReportSentOn", fallback: "10:00" },
  evening: { timeField: "eveningReportTime", sentField: "eveningReportSentOn", fallback: "18:00" },
};

/**
 * Companies whose report is due now, already claimed for today.
 * @param {"morning"|"evening"} kind
 * @param {object} [extraWhere]  e.g. { notifyAdminMissedClocks: true }
 * @returns {Promise<Array<{ id, name, timeZone, now: moment.Moment, dateKey: string }>>}
 */
async function claimDueCompanies(kind, extraWhere = {}) {
  const { timeField, sentField, fallback } = KINDS[kind];
  const companies = await prisma.company.findMany({
    where: { isActive: true, ...extraWhere },
    select: { id: true, name: true, timeZone: true, [timeField]: true, [sentField]: true },
  });

  const due = [];
  for (const company of companies) {
    const tz = moment.tz.zone(company.timeZone || "") ? company.timeZone : DEFAULT_TZ;
    const now = moment().tz(tz);
    const dateKey = now.format("YYYY-MM-DD");

    const [h, m] = String(company[timeField] || fallback).split(":").map(Number);
    const at = now.clone().startOf("day").hour(Number.isFinite(h) ? h : 0).minute(Number.isFinite(m) ? m : 0);
    if (now.isBefore(at) || now.diff(at, "hours", true) > LATE_LIMIT_HOURS) continue;

    // Stored as a DATE: compare against the company-zone date at UTC midnight.
    const today = new Date(`${dateKey}T00:00:00.000Z`);
    if (company[sentField] && new Date(company[sentField]).getTime() === today.getTime()) continue;

    const { count } = await prisma.company.updateMany({
      where: { id: company.id, OR: [{ [sentField]: null }, { [sentField]: { not: today } }] },
      data: { [sentField]: today },
    });
    if (count === 1) due.push({ id: company.id, name: company.name, timeZone: tz, now, dateKey });
  }
  return due;
}

const listName = (user) => {
  const first = user?.profile?.firstName?.trim() || "";
  const last = user?.profile?.lastName?.trim() || "";
  if (first && last) return `${last}, ${first}`;
  return last || first || user?.username || user?.email || "";
};

// Shift times are @db.Time: Prisma returns a Date anchored to the UTC epoch, so the
// stored wall-clock time is its UTC hours/minutes (same rule as liveUserService).
// Strings ("17:00" / "17:00:00") are passed through.
function shiftTimeStr(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.length === 5 ? `${value}:00` : value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// assignedDate (@db.Date) holds the calendar date at UTC midnight.
const calendarDate = (value) => new Date(value).toISOString().slice(0, 10);

module.exports = { claimDueCompanies, listName, shiftTimeStr, calendarDate };
