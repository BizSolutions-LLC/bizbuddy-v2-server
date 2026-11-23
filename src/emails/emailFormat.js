// src/emails/emailFormat.js
//
// BB-144: how values look in emails. Every time and date is shown in the
// company's time zone (or the shift's, when the caller passes it).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");

const DEFAULT_TZ = "America/Los_Angeles";
const zoneOf = (tz) => (tz && moment.tz.zone(tz) ? tz : DEFAULT_TZ);

const fmtTime = (d, tz) => (d ? moment(d).tz(zoneOf(tz)).format("h:mm A") : null); // 6:47 AM
const fmtDay = (d, tz) => (d ? moment(d).tz(zoneOf(tz)).format("ddd, MMM D") : null); // Mon, Nov 23
const fmtDateTime = (d, tz) => (d ? moment(d).tz(zoneOf(tz)).format("MMM D, YYYY · h:mm A") : null); // Nov 23, 2026 · 2:14 PM

/** 9.18 → "9.18h", 8 → "8h", null → null */
function fmtHours(n) {
  if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return null;
  const v = Math.round(Number(n) * 100) / 100;
  return `${v}h`;
}

/** Minutes → "5 minutes" / "1 hour" / "1 hour 30 minutes" */
function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m || !h) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

const firstNameOf = (user) => user?.profile?.firstName?.trim() || user?.username || "there";
const fullNameOf = (user) =>
  `${user?.profile?.firstName || ""} ${user?.profile?.lastName || ""}`.trim() || user?.username || user?.email || "";

/**
 * Last day of the open cutoff that covers a punch, shown as "Tue, Nov 24".
 * CutoffPeriod.periodStart / periodEnd hold calendar dates at UTC midnight, so
 * the punch is matched by its date in the company zone. A department's own
 * cutoff wins over a company-wide one. null when no open cutoff covers it.
 */
async function correctionDeadline({ companyId, departmentId, at, tz }) {
  if (!companyId || !at) return null;
  try {
    const ymd = moment(at).tz(zoneOf(tz)).format("YYYY-MM-DD");
    const day = new Date(`${ymd}T00:00:00.000Z`);
    const periods = await prisma.cutoffPeriod.findMany({
      where: {
        companyId,
        status: "open",
        periodStart: { lte: day },
        periodEnd: { gte: day },
        OR: [{ departmentId: null }, ...(departmentId ? [{ departmentId }] : [])],
      },
      select: { periodEnd: true, departmentId: true },
    });
    const pick = periods.find((p) => departmentId && p.departmentId === departmentId) || periods.find((p) => !p.departmentId);
    return pick ? moment.utc(pick.periodEnd).format("ddd, MMM D") : null;
  } catch (err) {
    console.error("[BB-144] correctionDeadline failed:", err.message);
    return null; // the row is simply left out
  }
}

module.exports = { zoneOf, fmtTime, fmtDay, fmtDateTime, fmtHours, fmtDuration, firstNameOf, fullNameOf, correctionDeadline };
