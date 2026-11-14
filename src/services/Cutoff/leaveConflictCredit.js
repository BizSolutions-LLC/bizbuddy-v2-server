// src/services/Cutoff/leaveConflictCredit.js
//
// Shared "punch wins over leave" logic, used by both daycareCutoffStrategy.js
// and bncCutoffStrategy.js's resolveConflict (manual "Honor Punch" and the
// company's "Automatically Resolve Punch-vs-Leave Conflicts" setting).
//
// BB-125: reverts only the punched DAY of the leave, not the whole request.
//   - That day's LeaveDay rows get revertedAt (+ the punch's timeLogId); every
//     hours reader skips reverted days, so the day stops counting as leave.
//   - Its paid hours go back to the balance and to the same fiscal-year lots
//     (restoreToLots), with an "adjustment" ledger row.
//   - A "reverted" ledger row records the event.
//   - The leave's actualPaidHours / actualUnpaidHours drop by that day.
//   - Once every day of the leave is reverted, Leave.status becomes "reverted".
//     Until then it stays "approved" (the client shows "Partly reverted").
// A leave approved before LeaveDay existed (no day rows) is reverted whole,
// refunding its recorded deduction.
//
// Must be called with a `tx` already inside a prisma $transaction.

const { prisma } = require("@config/connection");
const { loadCreditCompanyForPolicy, isTracked, restoreToLots } = require("@services/Leave/leaveCreditService");

const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function refund(tx, { leave, policyId, hours, userId, note }) {
  if (!(hours > 0) || !policyId) return;
  const existing = await tx.leaveBalance.findUnique({
    where: { userId_policyId: { userId: leave.userId, policyId } },
  });
  const balanceBefore = existing ? Number(existing.balanceHours) : 0;
  const balanceAfter  = r2(balanceBefore + hours);

  await tx.leaveBalance.upsert({
    where:  { userId_policyId: { userId: leave.userId, policyId } },
    update: { balanceHours: balanceAfter },
    create: { userId: leave.userId, policyId, balanceHours: balanceAfter },
  });

  // BB-098: put the hours back into the same fiscal-year lots the approval drew from.
  const creditCompany = await loadCreditCompanyForPolicy(tx, policyId);
  if (isTracked(creditCompany)) {
    await restoreToLots(tx, creditCompany, {
      userId: leave.userId, policyId, hours, balanceBefore, leaveId: leave.id,
    });
  }

  await tx.leaveTransaction.create({
    data: {
      userId:        leave.userId,
      policyId,
      type:          "adjustment",
      hours,
      balanceBefore,
      balanceAfter,
      leaveId:       leave.id,
      performedById: userId ?? null,
      note,
    },
  });
}

/**
 * Reverts one day of an approved leave because a punch on that day was honored.
 *
 * @param tx       prisma transaction client
 * @param leave    the Leave row (needs id, userId, policyId, leaveType)
 * @param dateStr  the punch's calendar date in the company zone, "YYYY-MM-DD"
 * @param userId   acting admin, or null for the automatic setting
 * @param timeLogId the honored punch
 * @returns {Promise<{ reverted: boolean, hours: number, leaveStatus: string|null }>}
 *   reverted=false when there was nothing left to revert (day already reverted,
 *   not a leave day, or the leave is no longer approved) — nothing was written.
 */
async function revertLeaveDayOnConflict(tx, { leave, dateStr, userId, timeLogId }) {
  const nothing = { reverted: false, hours: 0, leaveStatus: null };
  const cause = userId ? "Reverted: punch honored over leave" : "Auto-reverted: punch honored over leave";

  const deductionTxn = await tx.leaveTransaction.findFirst({
    where:   { leaveId: leave.id, type: "deduction" },
    orderBy: { createdAt: "desc" },
  });
  const policyId = deductionTxn?.policyId ?? leave.policyId ?? leave.leaveType;

  const dayCount = await tx.leaveDay.count({ where: { leaveId: leave.id } });

  // ── Legacy leave (no LeaveDay rows): revert the whole request ──────────────
  if (dayCount === 0) {
    const claim = await tx.leave.updateMany({
      where: { id: leave.id, status: "approved" },
      data:  { status: "reverted" },
    });
    if (claim.count === 0) return nothing;
    const hours = deductionTxn ? Math.abs(Number(deductionTxn.hours)) : 0;
    await tx.leaveTransaction.create({
      data: {
        userId: leave.userId, policyId, type: "reverted", leaveId: leave.id,
        performedById: userId ?? null,
        note: `${cause} — ${dateStr} (whole leave: no per-day records)`,
      },
    });
    await refund(tx, { leave, policyId, hours, userId, note: `${cause} — ${dateStr}` });
    return { reverted: true, hours, leaveStatus: "reverted" };
  }

  // ── Per-day revert ─────────────────────────────────────────────────────────
  const dayDate = new Date(`${dateStr}T00:00:00.000Z`);
  const days = await tx.leaveDay.findMany({
    where: { leaveId: leave.id, date: dayDate, revertedAt: null },
  });
  if (!days.length) return nothing;

  // The leave must still be approved — claim it first so a concurrent revert
  // (e.g. the 3 segment approvals of one Driver/Aide day) can't double-refund.
  const stillApproved = await tx.leave.updateMany({
    where: { id: leave.id, status: "approved" },
    data:  { updatedAt: new Date() },
  });
  if (stillApproved.count === 0) return nothing;

  const claimed = await tx.leaveDay.updateMany({
    where: { id: { in: days.map((d) => d.id) }, revertedAt: null },
    data:  { revertedAt: new Date(), revertedTimeLogId: timeLogId ?? null },
  });
  if (claimed.count !== days.length) {
    throw new Error(`Leave day ${dateStr} of ${leave.id} was reverted concurrently — rolled back`);
  }

  const paid   = r2(days.filter((d) => d.isPaid).reduce((s, d) => s + Number(d.hours), 0));
  const unpaid = r2(days.filter((d) => !d.isPaid).reduce((s, d) => s + Number(d.hours), 0));
  const remaining = await tx.leaveDay.count({ where: { leaveId: leave.id, revertedAt: null } });

  const current = await tx.leave.findUnique({
    where:  { id: leave.id },
    select: { actualPaidHours: true, actualUnpaidHours: true },
  });
  const leaveStatus = remaining === 0 ? "reverted" : "approved";
  await tx.leave.update({
    where: { id: leave.id },
    data: {
      ...(current?.actualPaidHours   != null && { actualPaidHours:   Math.max(0, r2(Number(current.actualPaidHours)   - paid)) }),
      ...(current?.actualUnpaidHours != null && { actualUnpaidHours: Math.max(0, r2(Number(current.actualUnpaidHours) - unpaid)) }),
      ...(remaining === 0 && { status: "reverted" }),
    },
  });

  await tx.leaveTransaction.create({
    data: {
      userId: leave.userId, policyId, type: "reverted", leaveId: leave.id,
      performedById: userId ?? null,
      note: `${cause} — ${dateStr}: ${paid}h paid${unpaid ? `, ${unpaid}h unpaid` : ""} returned`
        + (remaining === 0 ? " (all days reverted)" : ` (${remaining} leave day(s) remain)`),
    },
  });
  await refund(tx, { leave, policyId, hours: paid, userId, note: `${cause} — ${dateStr}` });

  return { reverted: true, hours: paid, leaveStatus };
}

/**
 * The approved leave covering a calendar day, matched by date (BB-073/BB-125).
 * Leave dates are calendar dates stored around noon in the company zone, so a
 * timestamp comparison against a morning punch misses them — compare the
 * YYYY-MM-DD part instead, same as getCutoffApprovals' conflict detection.
 */
async function findApprovedLeaveForDay(db, userId, dateStr) {
  const day = new Date(`${dateStr}T00:00:00.000Z`);
  const candidates = await db.leave.findMany({
    where: {
      userId,
      status:    "approved",
      startDate: { lte: new Date(day.getTime() + 2 * 86400000) },
      endDate:   { gte: new Date(day.getTime() - 86400000) },
    },
    orderBy: { startDate: "asc" },
  });
  return candidates.find((l) =>
    l.startDate.toISOString().slice(0, 10) <= dateStr && l.endDate.toISOString().slice(0, 10) >= dateStr
  ) ?? null;
}

// BB-125: revert the punched day of the approved leave (matched by calendar date,
// not timestamp — the BB-073 bug). Best-effort: the punch approval above already
// happened and must not be rolled back if the leave side fails; the result says
// whether it worked so callers never report a revert that didn't happen.
// Used by both cutoff strategies' resolveConflict.
async function revertLeaveForPunch(timeLog, localDateStr, userId) {
  try {
    const leave = await findApprovedLeaveForDay(prisma, timeLog.userId, localDateStr);
    if (!leave) {
      // A sibling Driver/Aide segment may have reverted it already (a 1-day leave is
      // then "reverted", no longer "approved").
      const done = await prisma.leaveDay.findFirst({
        where: { revertedTimeLogId: timeLog.id, date: new Date(`${localDateStr}T00:00:00.000Z`) },
      });
      return { reverted: false, hours: 0, leaveStatus: null, alreadyReverted: !!done };
    }
    const result = await prisma.$transaction(
      (tx) => revertLeaveDayOnConflict(tx, { leave, dateStr: localDateStr, userId, timeLogId: timeLog.id }),
      { maxWait: 10000, timeout: 30000 } // ~15 queries; the 5 s default is tight under load
    );
    if (result.reverted) {
      console.log("[✅ BB-125] Leave day reverted and credit returned", leave.id, localDateStr, `${result.hours}h`);
      return { ...result, alreadyReverted: false };
    }
    // Nothing reverted: either that day was already reverted (fine) or the leave
    // has no counted day on that date (e.g. an excluded weekend) — only the first
    // counts as done.
    const done = await prisma.leaveDay.findFirst({
      where: { leaveId: leave.id, date: new Date(`${localDateStr}T00:00:00.000Z`), revertedAt: { not: null } },
    });
    return { ...result, alreadyReverted: !!done };
  } catch (leaveErr) {
    console.error("[⚠️  BB-125] Could not revert leave day:", leaveErr.message);
    return { reverted: false, hours: 0, leaveStatus: null, alreadyReverted: false, error: leaveErr.message };
  }
}

function honorPunchResult(choice, leaveResult) {
  const ok = leaveResult.reverted || leaveResult.alreadyReverted;
  return {
    message: leaveResult.reverted
      ? `Punch honored. Leave day reverted — ${leaveResult.hours}h returned to the employee's balance.`
      : leaveResult.alreadyReverted
        ? "Punch honored. The leave day was already reverted."
        : "Punch honored. Note: the leave day could not be reverted automatically — please review manually.",
    data: {
      choice,
      punchApproved:  true,
      leaveReverted:  ok,
      leaveCancelled: ok, // legacy name — kept for existing callers
      revertedHours:  leaveResult.hours,
      leaveStatus:    leaveResult.leaveStatus,
    },
  };
}

module.exports = { revertLeaveDayOnConflict, findApprovedLeaveForDay, revertLeaveForPunch, honorPunchResult };
