// src/services/cutoff/cutoffOtService.js
//
// Computes and persists CutoffOtBlock records.
//
// Supported otBasis values:
//
//   "daily"  — B&C: sum approved hours per employee per calendar day.
//              If total > company.dailyOtThresholdHours, upsert one block per day.
//
//   "cutoff" — DayCare: sum approved hours per employee across the entire cutoff
//              period. If total > company.cutoffOtThresholdHours, upsert one block
//              using the cutoff periodEnd as the date key.
//
// "weekly" remains a no-op.
//
// Upsert resets status to "pending" whenever otHours changes — the admin must
// re-approve after any punch edit that alters the OT amount.

const { prisma } = require("@config/connection");
const moment     = require("moment-timezone");

/**
 * Recompute the OT block for one employee on one calendar day.
 *
 * @param {string} cutoffPeriodId
 * @param {string} userId
 * @param {string} dateStr   — "YYYY-MM-DD" in the company timezone
 * @param {string} companyId
 */
async function computeOtForEmployeeDay(cutoffPeriodId, userId, dateStr, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { otBasis: true, dailyOtThresholdHours: true, timeZone: true },
  });

  // Only daily OT is implemented — skip other bases silently.
  if (!company || company.otBasis !== "daily") return;

  const threshold = parseFloat(company.dailyOtThresholdHours ?? 8);
  const tz        = company.timeZone || "America/Los_Angeles";

  // Build the UTC window that covers the company-timezone calendar day.
  const dayStart = moment.tz(dateStr, tz).startOf("day").toDate();
  const dayEnd   = moment.tz(dateStr, tz).endOf("day").toDate();

  // Sum approved hours for this user on this day.
  // Uses actualHours from the TimeLogApproval — set explicitly at approval time and
  // authoritative for payroll. Falls back to computing from approved timestamps if
  // actualHours is null (legacy records approved before bncCutoffStrategy), then to
  // netWorkedHours as a last resort.
  const approved = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId,
      status:  "approved",
      timeLog: {
        userId,
        timeIn: { gte: dayStart, lte: dayEnd },
      },
    },
    select: {
      actualHours:      true,
      approvedClockIn:  true,
      approvedClockOut: true,
      timeLog: { select: { netWorkedHours: true } },
    },
  });

  const totalHours = approved.reduce((sum, a) => {
    if (a.actualHours != null) {
      return sum + parseFloat(a.actualHours.toString());
    }
    if (a.approvedClockIn && a.approvedClockOut) {
      return sum + (new Date(a.approvedClockOut) - new Date(a.approvedClockIn)) / 3600000;
    }
    return sum + parseFloat(a.timeLog?.netWorkedHours?.toString() ?? 0);
  }, 0);

  const otHours = parseFloat(Math.max(0, totalHours - threshold).toFixed(2));
  const date    = new Date(dateStr);

  if (otHours > 0) {
    const existing = await prisma.cutoffOtBlock.findUnique({
      where: { cutoffPeriodId_userId_date: { cutoffPeriodId, userId, date } },
      select: { otHours: true, status: true },
    });

    const currentOt = existing ? parseFloat(existing.otHours.toString()) : null;
    const hoursChanged = currentOt === null || Math.abs(currentOt - otHours) >= 0.01;

    await prisma.cutoffOtBlock.upsert({
      where:  { cutoffPeriodId_userId_date: { cutoffPeriodId, userId, date } },
      create: { cutoffPeriodId, userId, date, otHours, status: "pending" },
      // Reset to pending when the OT amount changes — admin must re-review.
      update: hoursChanged ? { otHours, status: "pending" } : { otHours },
    });

    console.log(`[OT] Upserted block — ${userId} on ${dateStr}: ${otHours}h OT`);
  } else {
    const deleted = await prisma.cutoffOtBlock.deleteMany({
      where: { cutoffPeriodId, userId, date },
    });
    if (deleted.count > 0) {
      console.log(`[OT] Removed block — ${userId} on ${dateStr}: total hours now ≤ threshold`);
    }
  }
}

/**
 * Recompute the OT block for one employee across the entire cutoff period.
 * Used when otBasis === "cutoff" (e.g. DayCare with 80h/period threshold).
 *
 * One CutoffOtBlock per employee per cutoff, keyed on the cutoff's periodEnd date.
 *
 * @param {string} cutoffPeriodId
 * @param {string} userId
 * @param {string} companyId
 */
async function computeOtForCutoffBasis(cutoffPeriodId, userId, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { otBasis: true, cutoffOtThresholdHours: true },
  });
  if (!company || company.otBasis !== "cutoff") return;

  const threshold = parseFloat(company.cutoffOtThresholdHours ?? 80);

  const cutoffPeriod = await prisma.cutoffPeriod.findUnique({
    where:  { id: cutoffPeriodId },
    select: { periodEnd: true },
  });
  if (!cutoffPeriod) return;

  // Training records are EXCLUDED from the OT basis (supersedes Bug 6, v2.10.18 —
  // see docs/TIMEKEEPING_GLOSSARY.md). Training's actualHours is a flat, capped
  // credit; leaving it inside the total compared against the period Threshold
  // doesn't just pay its own flat amount — it also pushes other, actually-worked
  // hours across the OT line, manufacturing OT premium the employee never worked
  // for. Training is still paid in full via TOTAL PAYABLE; it is simply not
  // measured against the OT threshold.
  const approved = await prisma.timeLogApproval.findMany({
    where: {
      cutoffPeriodId,
      status:  "approved",
      timeLog: { userId },
    },
    select: {
      actualHours:      true,
      approvedClockIn:  true,
      approvedClockOut: true,
      timeLog: { select: { netWorkedHours: true, punchType: true } },
    },
  });

  let trainingHoursExcluded = 0;
  const otBasisHours = approved.reduce((sum, a) => {
    const hours = a.actualHours != null
      ? parseFloat(a.actualHours.toString())
      : a.approvedClockIn && a.approvedClockOut
        ? (new Date(a.approvedClockOut) - new Date(a.approvedClockIn)) / 3600000
        : parseFloat(a.timeLog?.netWorkedHours?.toString() ?? 0);

    if (a.timeLog?.punchType === "TRAINING") {
      trainingHoursExcluded += hours;
      return sum;
    }
    return sum + hours;
  }, 0);

  const otHours = parseFloat(Math.max(0, otBasisHours - threshold).toFixed(2));
  const date    = cutoffPeriod.periodEnd;

  if (otHours > 0) {
    const existing = await prisma.cutoffOtBlock.findUnique({
      where: { cutoffPeriodId_userId_date: { cutoffPeriodId, userId, date } },
      select: { otHours: true },
    });

    const currentOt    = existing ? parseFloat(existing.otHours.toString()) : null;
    const hoursChanged = currentOt === null || Math.abs(currentOt - otHours) >= 0.01;

    await prisma.cutoffOtBlock.upsert({
      where:  { cutoffPeriodId_userId_date: { cutoffPeriodId, userId, date } },
      create: { cutoffPeriodId, userId, date, otHours, status: "pending" },
      update: hoursChanged ? { otHours, status: "pending" } : { otHours },
    });

    console.log(`[OT] Upserted cutoff block — ${userId}: ${otHours}h OT (${otBasisHours.toFixed(2)}h worked vs ${threshold}h threshold; ${trainingHoursExcluded.toFixed(2)}h training excluded)`);
  } else {
    const deleted = await prisma.cutoffOtBlock.deleteMany({
      where: { cutoffPeriodId, userId, date },
    });
    if (deleted.count > 0) {
      console.log(`[OT] Removed cutoff block — ${userId}: total hours now ≤ threshold`);
    }
  }
}

/**
 * Called after a single punch approval or edit.
 * Dispatches to the correct OT computation based on company.otBasis.
 *
 * @param {string} timeLogId
 * @param {string} cutoffPeriodId
 * @param {string} companyId
 */
async function recomputeOtForTimeLog(timeLogId, cutoffPeriodId, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { otBasis: true, timeZone: true },
  });
  if (!company) return;

  if (company.otBasis === "daily") {
    const timeLog = await prisma.timeLog.findUnique({
      where:  { id: timeLogId },
      select: { userId: true, timeIn: true },
    });
    if (!timeLog) return;
    const tz      = company.timeZone || "America/Los_Angeles";
    const dateStr = moment.tz(timeLog.timeIn, tz).format("YYYY-MM-DD");
    await computeOtForEmployeeDay(cutoffPeriodId, timeLog.userId, dateStr, companyId);
  } else if (company.otBasis === "cutoff") {
    const timeLog = await prisma.timeLog.findUnique({
      where:  { id: timeLogId },
      select: { userId: true },
    });
    if (!timeLog) return;
    await computeOtForCutoffBasis(cutoffPeriodId, timeLog.userId, companyId);
  }
  // "weekly" remains a no-op
}

/**
 * Called after bulk approval or sync — recomputes OT for every affected
 * employee in this cutoff. Dispatches on company.otBasis.
 *
 * @param {string} cutoffPeriodId
 * @param {string} companyId
 */
async function recomputeAllOtForCutoff(cutoffPeriodId, companyId) {
  const company = await prisma.company.findUnique({
    where:  { id: companyId },
    select: { otBasis: true, timeZone: true },
  });
  if (!company) return;

  const approved = await prisma.timeLogApproval.findMany({
    where:   { cutoffPeriodId, status: "approved" },
    include: { timeLog: { select: { userId: true, timeIn: true } } },
  });

  if (company.otBasis === "daily") {
    const tz = company.timeZone || "America/Los_Angeles";

    // Deduplicate to unique userId + dateStr pairs.
    const seen  = new Set();
    const pairs = [];
    for (const a of approved) {
      if (!a.timeLog) continue;
      const dateStr = moment.tz(a.timeLog.timeIn, tz).format("YYYY-MM-DD");
      const key = `${a.timeLog.userId}:${dateStr}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ userId: a.timeLog.userId, dateStr });
      }
    }

    for (const { userId, dateStr } of pairs) {
      try {
        await computeOtForEmployeeDay(cutoffPeriodId, userId, dateStr, companyId);
      } catch (err) {
        console.error(`[OT] recomputeAllOtForCutoff (daily) failed for ${userId} on ${dateStr}:`, err.message);
      }
    }
  } else if (company.otBasis === "cutoff") {
    // Deduplicate to unique userIds — one block covers the whole period per employee.
    const userIds = [...new Set(approved.filter(a => a.timeLog).map(a => a.timeLog.userId))];

    for (const userId of userIds) {
      try {
        await computeOtForCutoffBasis(cutoffPeriodId, userId, companyId);
      } catch (err) {
        console.error(`[OT] recomputeAllOtForCutoff (cutoff) failed for ${userId}:`, err.message);
      }
    }
  }
  // "weekly" remains a no-op
}

module.exports = { recomputeOtForTimeLog, recomputeAllOtForCutoff, computeOtForCutoffBasis };
