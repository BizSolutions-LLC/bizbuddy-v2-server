// src/services/Cutoff/leaveConflictCredit.js
//
// Shared "punch wins over leave" cancel + credit logic, used by both
// daycareCutoffStrategy.js and bncCutoffStrategy.js's resolveConflict.
// Pulled out into one file so the two strategies can't drift the way the
// old inline copies did (one flat-8h credit, no ledger entry, in both files).

// Cancels an approved leave and credits back the real deducted hours (read
// off the original "deduction" LeaveTransaction, not a flat amount). Writes
// a "cancelled" lifecycle ledger row (mirrors cancelLeave's shape exactly —
// hours stay null) plus a separate "adjustment" balance-movement row when
// there's a real credit to apply, mirroring the deduction/approved pair
// applyLeaveApproval already writes at approval time.
//
// Must be called with a `tx` that is already inside a prisma $transaction,
// so the leave-status flip, balance credit, and ledger writes are atomic.
//
// @returns {Promise<boolean>} true if this call is the one that cancelled
//   the leave; false if it lost a race against a concurrent call (nothing
//   left to credit).
async function creditLeaveOnConflict(tx, { leave, userId }) {
  // Atomic claim — only proceed if this call is the one that actually flips
  // approved -> cancelled. Guards against double-crediting if resolveConflict
  // is ever invoked twice for the same leave (e.g. two overlapping punch
  // conflicts on a multi-day leave).
  const claim = await tx.leave.updateMany({
    where: { id: leave.id, status: "approved" },
    data: {
      status:           "cancelled",
      approverComments: "Cancelled — conflict resolved in favour of punch during cutoff review",
    },
  });
  if (claim.count === 0) return false;

  // userId is the acting admin for a manual conflict resolution, or null for
  // BB-051's unattended leaveConflictAutoRevert.
  const cause = userId
    ? "Cancelled: punch honored over leave"
    : "Auto-reverted: punch honored over leave";

  const deductionTxn = await tx.leaveTransaction.findFirst({
    where:   { leaveId: leave.id, type: "deduction" },
    orderBy: { createdAt: "desc" },
  });

  const creditHours = deductionTxn ? Math.abs(Number(deductionTxn.hours)) : 0;
  const policyId     = deductionTxn?.policyId ?? leave.policyId;

  await tx.leaveTransaction.create({
    data: {
      userId:        leave.userId,
      policyId,
      type:          "cancelled",
      leaveId:       leave.id,
      performedById: userId ?? null,
      note: creditHours > 0
        ? cause
        // Unpaid leave, insufficient-balance approval, or legacy pre-fix
        // data with no recorded deduction — nothing to credit back.
        : `${cause} (no prior paid deduction found — no balance credit issued)`,
    },
  });

  if (creditHours > 0 && policyId) {
    const existing = await tx.leaveBalance.findUnique({
      where: { userId_policyId: { userId: leave.userId, policyId } },
    });
    const balanceBefore = existing ? Number(existing.balanceHours) : 0;
    const balanceAfter  = +(balanceBefore + creditHours).toFixed(2);

    await tx.leaveBalance.upsert({
      where:  { userId_policyId: { userId: leave.userId, policyId } },
      update: { balanceHours: balanceAfter },
      create: { userId: leave.userId, policyId, balanceHours: balanceAfter },
    });

    await tx.leaveTransaction.create({
      data: {
        userId:        leave.userId,
        policyId,
        type:          "adjustment",
        hours:         creditHours,
        balanceBefore,
        balanceAfter,
        leaveId:       leave.id,
        performedById: userId ?? null,
        note:          cause,
      },
    });
  }

  return true;
}

module.exports = { creditLeaveOnConflict };
