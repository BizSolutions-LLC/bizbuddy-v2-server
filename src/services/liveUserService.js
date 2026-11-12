// src/services/liveUserService.js
//
// Manages the LiveUser table — one row per active clock-in session.
// Pre-computes warnAt and closeAt at clock-in so cron queries are simple
// indexed range scans instead of per-row date arithmetic.

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");

// ── Timezone helpers ──────────────────────────────────────────────────────────

/**
 * Extracts the stored clock-time string (HH:mm:ss) from a Prisma @db.Time value.
 * Prisma anchors @db.Time to the UTC epoch so getUTCHours/Minutes gives the stored time.
 */
function timeStrFromDbTime(t) {
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Combines a calendar date (referenceDate) with a @db.Time value in a named IANA timezone.
 * Advances by one day if the resolved time is before referenceDate (cross-midnight shift).
 */
function combineDateWithTimeTz(referenceDate, timeLikeDate, tz) {
  const dateOnly = moment(referenceDate).tz(tz).format("YYYY-MM-DD");
  const timeStr  = timeStrFromDbTime(timeLikeDate);
  const result   = moment.tz(`${dateOnly} ${timeStr}`, "YYYY-MM-DD HH:mm:ss", tz).toDate();
  if (result <= new Date(referenceDate)) {
    return moment(result).add(1, "day").toDate();
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates (or upserts) a LiveUser record at clock-in.
 *
 * Resolves scheduledEnd as the latest shift endTime for the clock-in date in
 * the company timezone.  Falls back to timeIn + defaultShiftHours when no
 * shift is assigned.
 *
 * warnAt  = scheduledEnd − autoClockOutWarningHours
 * closeAt = scheduledEnd + autoClockOutGraceHours
 *
 * Non-fatal: a failure here never blocks the clock-in response.
 *
 * @param {string} userId
 * @param {string} timeLogId  — the newly-created TimeLog id
 * @param {Date}   timeIn     — actual clock-in timestamp
 */
async function createLiveUser(userId, timeLogId, timeIn) {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        companyId: true,
        company: {
          select: {
            timeZone:                 true,
            defaultShiftHours:        true,
            autoClockOutWarningHours: true,
            autoClockOutGraceHours:   true,
          },
        },
      },
    });

    if (!user?.companyId) return;

    const companyId         = user.companyId;
    const tz                = user.company?.timeZone || "America/Los_Angeles";
    const defaultShiftHours = parseFloat(user.company?.defaultShiftHours        ?? 8);
    const warningHours      = parseFloat(user.company?.autoClockOutWarningHours  ?? 0.5);
    const graceHours        = parseFloat(user.company?.autoClockOutGraceHours    ?? 1.0);

    // ── Resolve scheduledEnd ─────────────────────────────────────────────────
    // Fetch all UserShifts for the clock-in date; use the latest-ending shift.
    const clockInDate = new Date(timeIn);
    const dayStart    = moment(clockInDate).tz(tz).startOf("day").toDate();
    const dayEnd      = moment(clockInDate).tz(tz).endOf("day").toDate();

    const userShifts = await prisma.userShift.findMany({
      where: {
        userId,
        assignedDate: { gte: dayStart, lte: dayEnd },
        status: { not: "cancelled" },
      },
      include: { shift: true },
    });

    let scheduledEnd = null;

    if (userShifts.length > 0) {
      let latestShift = null;
      let latestEndMs = -Infinity;
      for (const us of userShifts) {
        if (!us.shift?.endTime) continue;
        const endMs = new Date(us.shift.endTime).getTime();
        if (endMs > latestEndMs) {
          latestEndMs = endMs;
          latestShift = us.shift;
        }
      }
      if (latestShift?.endTime) {
        // BB-122: shift clock times belong to the shift's own zone (stamped at
        // creation), not the company's current zone — same rule as the cutoff
        // strategies. Fixes early auto clock-out after a company zone change.
        const shiftTz = latestShift.timeZone && moment.tz.zone(latestShift.timeZone)
          ? latestShift.timeZone
          : tz;
        scheduledEnd = combineDateWithTimeTz(clockInDate, latestShift.endTime, shiftTz);
      }
    }

    if (!scheduledEnd) {
      // Fallback: timeIn + defaultShiftHours
      scheduledEnd = new Date(clockInDate.getTime() + defaultShiftHours * 3_600_000);
    }

    const warnAt  = new Date(scheduledEnd.getTime() - warningHours * 3_600_000);
    const closeAt = new Date(scheduledEnd.getTime() + graceHours   * 3_600_000);

    // Upsert — handles stale rows left by a previous unclean session
    await prisma.liveUser.upsert({
      where:  { userId },
      create: { userId, companyId, timeLogId, scheduledEnd, warnAt, closeAt, warningSent: false },
      update: { timeLogId, scheduledEnd, warnAt, closeAt, warningSent: false },
    });
  } catch (err) {
    console.error("[liveUserService] createLiveUser failed:", err.message);
  }
}

/**
 * Removes a LiveUser record at self clock-out.
 * Silently no-ops if the row doesn't exist (already removed or never created).
 *
 * @param {string} userId
 */
async function removeLiveUser(userId) {
  try {
    await prisma.liveUser.delete({ where: { userId } });
  } catch (err) {
    if (err.code !== "P2025") {
      // P2025 = record not found — expected when row is already gone
      console.error("[liveUserService] removeLiveUser failed:", err.message);
    }
  }
}

module.exports = { createLiveUser, removeLiveUser };
