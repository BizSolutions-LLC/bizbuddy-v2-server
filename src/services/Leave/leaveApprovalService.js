// src/services/Leave/leaveApprovalService.js
//
// Centralized ledger-writing service for leave approval (Phase 4 of the Leave
// Module redo — see docs/LEAVE_MODULE.md §6, §10, §14b). Every
// balance-affecting action on approval goes through here so LeaveDay creation,
// the LeaveBalance decrement, and the LeaveTransaction ledger entry always
// happen together, atomically — this is what closes the ledger-integrity gap
// documented in OLD_LEAVE_MODULE.md §9.4.

const { prisma } = require("@config/connection");
const { calcDailyHours } = require("@utils/leaveUtils");

/**
 * Prorates a day-by-day hours breakdown against an available balance.
 * Pure function — no I/O, no side effects — used by both the read-only
 * preview and the actual apply step so they can never disagree.
 *
 * BB-045: the one day where the balance runs out partway through now splits
 * into two entries sharing the same date — a paid portion (whatever balance
 * remained) and an unpaid portion (the rest) — instead of the whole day
 * falling to unpaid and stranding the leftover balance. Every day before
 * that split point is fully paid; every day after it is fully unpaid.
 *
 * @param {Array<{date: string, hours: number}>} dailyHours
 * @param {number} availableBalance
 * @param {boolean} negativeAllowed - if true, every day is paid regardless of balance
 * @returns {{ days: Array<{date, hours, isPaid}>, paidHours: number, unpaidHours: number }}
 */
function computeProration(dailyHours, availableBalance, negativeAllowed) {
  let available = availableBalance;
  let paidHours = 0;
  let unpaidHours = 0;
  const days = [];

  for (const d of dailyHours) {
    if (negativeAllowed || available >= d.hours) {
      available -= d.hours;
      paidHours += d.hours;
      days.push({ date: d.date, hours: d.hours, isPaid: true });
    } else if (available > 0) {
      // Split day — whatever balance remains covers part of it, the rest
      // auto-falls to unpaid. Two rows, same date.
      const paidPortion   = available;
      const unpaidPortion = d.hours - available;
      paidHours   += paidPortion;
      unpaidHours += unpaidPortion;
      days.push({ date: d.date, hours: +paidPortion.toFixed(2),   isPaid: true });
      days.push({ date: d.date, hours: +unpaidPortion.toFixed(2), isPaid: false });
      available = 0;
    } else {
      unpaidHours += d.hours;
      days.push({ date: d.date, hours: d.hours, isPaid: false });
    }
  }

  return {
    days,
    paidHours: +paidHours.toFixed(2),
    unpaidHours: +unpaidHours.toFixed(2),
  };
}

/**
 * Read-only preview of what approving `leave` would do — for the approver's
 * dashboard to show before they confirm. Writes nothing.
 */
async function previewLeaveApproval(leave, policy) {
  const dailyHours = await calcDailyHours(leave.userId, leave.startDate, leave.endDate, {
    requestedStartTime: leave.requestedStartTime,
    requestedEndTime:   leave.requestedEndTime,
    excludeShiftIds:    Array.isArray(leave.excludedShiftIds) ? leave.excludedShiftIds : [],
    includeWeekends:    leave.includeWeekends !== false,
  });

  if (!leave.isPaid) {
    return {
      isPaid: false,
      availableBalance: null,
      days: dailyHours.map((d) => ({ ...d, isPaid: false })),
      paidHours: 0,
      unpaidHours: +dailyHours.reduce((s, d) => s + d.hours, 0).toFixed(2),
    };
  }

  const bal = await prisma.leaveBalance.findUnique({
    where: { userId_policyId: { userId: leave.userId, policyId: policy.id } },
  });
  const availableBalance = bal ? Number(bal.balanceHours) : 0;
  const result = computeProration(dailyHours, availableBalance, policy.negativeAllowed);

  return { isPaid: true, availableBalance, ...result };
}

/**
 * Applies a leave approval: creates LeaveDay rows for every deductible day,
 * and — for days that end up paid — decrements LeaveBalance and writes a
 * single consolidated `deduction` LeaveTransaction, all in one transaction.
 *
 * Deliberate-unpaid requests (leave.isPaid === false) never touch balance —
 * that's the employee's explicit choice (see LEAVE_MODULE.md §5),
 * not just an insufficient-balance fallback.
 *
 * @returns {{ paidHours: number, unpaidHours: number }}
 */
async function applyLeaveApproval(leave, policy, approverId, note) {
  const dailyHours = await calcDailyHours(leave.userId, leave.startDate, leave.endDate, {
    requestedStartTime: leave.requestedStartTime,
    requestedEndTime:   leave.requestedEndTime,
    excludeShiftIds:    Array.isArray(leave.excludedShiftIds) ? leave.excludedShiftIds : [],
    includeWeekends:    leave.includeWeekends !== false,
  });

  if (!leave.isPaid) {
    const unpaidHours = +dailyHours.reduce((s, d) => s + d.hours, 0).toFixed(2);

    await prisma.$transaction(async (tx) => {
      if (dailyHours.length) {
        await tx.leaveDay.createMany({
          data: dailyHours.map((d) => ({
            leaveId: leave.id,
            date:    new Date(d.date),
            isPaid:  false,
            hours:   d.hours,
          })),
          skipDuplicates: true,
        });
      }
      await tx.leave.update({
        where: { id: leave.id },
        data:  { actualPaidHours: 0, actualUnpaidHours: unpaidHours },
      });
      // Leave Ledger — lifecycle event, no balance movement (deliberate-unpaid
      // choice never touches balance, see §5/§6).
      await tx.leaveTransaction.create({
        data: {
          userId:        leave.userId,
          policyId:      policy.id,
          type:          "approved",
          leaveId:       leave.id,
          performedById: approverId ?? null,
          note:          `${note ? note + " — " : ""}0h paid, ${unpaidHours}h unpaid (deliberate unpaid request)`,
        },
      });
    });

    return { paidHours: 0, unpaidHours };
  }

  return prisma.$transaction(async (tx) => {
    const bal = await tx.leaveBalance.upsert({
      where:  { userId_policyId: { userId: leave.userId, policyId: policy.id } },
      update: {},
      create: { userId: leave.userId, policyId: policy.id, balanceHours: 0 },
    });

    const balanceBefore = Number(bal.balanceHours);
    const { days, paidHours, unpaidHours } = computeProration(
      dailyHours,
      balanceBefore,
      policy.negativeAllowed
    );

    if (days.length) {
      await tx.leaveDay.createMany({
        data: days.map((d) => ({
          leaveId: leave.id,
          date:    new Date(d.date),
          isPaid:  d.isPaid,
          hours:   d.hours,
        })),
        skipDuplicates: true,
      });
    }

    if (paidHours > 0) {
      const balanceAfter = +(balanceBefore - paidHours).toFixed(2);
      await tx.leaveBalance.update({
        where: { id: bal.id },
        data:  { balanceHours: balanceAfter },
      });
      await tx.leaveTransaction.create({
        data: {
          userId:        leave.userId,
          policyId:      policy.id,
          type:          "deduction",
          hours:         -paidHours,
          balanceBefore,
          balanceAfter,
          leaveId:       leave.id,
          performedById: approverId ?? null,
          note: unpaidHours > 0
            ? `${note ? note + " — " : ""}${paidHours}h paid, ${unpaidHours}h auto-unpaid (insufficient balance)`
            : (note ?? null),
        },
      });
    }

    await tx.leave.update({
      where: { id: leave.id },
      data:  { actualPaidHours: paidHours, actualUnpaidHours: unpaidHours },
    });

    // Leave Ledger — the lifecycle "approved" marker, distinct from the
    // "deduction" row above (which only exists when paidHours > 0). Every
    // decision gets exactly one lifecycle event; a paid approval additionally
    // gets its own balance-movement row.
    await tx.leaveTransaction.create({
      data: {
        userId:        leave.userId,
        policyId:      policy.id,
        type:          "approved",
        leaveId:       leave.id,
        performedById: approverId ?? null,
        note: unpaidHours > 0
          ? `${note ? note + " — " : ""}${paidHours}h paid, ${unpaidHours}h auto-unpaid (insufficient balance)`
          : (note ?? null),
      },
    });

    return { paidHours, unpaidHours };
  });
}

module.exports = { computeProration, previewLeaveApproval, applyLeaveApproval };
