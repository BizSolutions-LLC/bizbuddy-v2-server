// src/controllers/Features/leaveController.js

const { prisma } = require("@config/connection");
const { calcDailyHours, calcRequestedHours, leaveVisibilityWhere } = require("@utils/leaveUtils");
const { previewLeaveApproval, applyLeaveApproval } = require("@services/Leave/leaveApprovalService");
const { createNotification } = require("@services/notificationService");
const { getEligibleApprovers } = require("@services/Approvers/approverResolutionService");
const { getIO } = require("@config/socket");
const moment = require("moment-timezone");

const _format = (l) => ({
  ...l,
  startDate: l.startDate.toISOString().slice(0, 10),
  endDate:   l.endDate.toISOString().slice(0, 10),
  createdAt: l.createdAt.toISOString(),
  updatedAt: l.updatedAt.toISOString(),
});

// ─── Resolve a leave's policy — policyId FK first, then legacy leaveType (ID or name) ─
async function _resolvePolicy(leave, companyId) {
  if (leave.policyId) {
    const byFk = await prisma.leavePolicy.findFirst({ where: { id: leave.policyId, companyId } });
    if (byFk) return byFk;
  }
  let policy = await prisma.leavePolicy.findFirst({ where: { id: leave.leaveType } });
  if (!policy) {
    policy = await prisma.leavePolicy.findFirst({
      where: { companyId, leaveType: leave.leaveType },
    });
  }
  return policy;
}

// ─── Eligible approver pool: any admin/superadmin (company-wide), or a ───────
// ─── supervisor whose department matches the leave requester's department ────
function _isEligibleApprover(actingRole, actingDepartmentId, requesterDepartmentId) {
  if (["admin", "superadmin"].includes(actingRole)) return true;
  if (actingRole === "supervisor") {
    return !!requesterDepartmentId && actingDepartmentId === requesterDepartmentId;
  }
  return false;
}

// ─── Parse "HH:MM" into a UTC-epoch-anchored Date for @db.Time storage — ─────
// ─── same convention as shiftController.js's createShift ─────────────────────
const TIME_HHMM_RE = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
function _parseTimeHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

// ─── Attach requestedHours to a list of already-formatted leave records ───────
async function _attachRequestedHours(leaves) {
  const hours = await Promise.all(
    leaves.map((l) =>
      calcRequestedHours(l.userId, l.startDate, l.endDate, {
        requestedStartTime: l.requestedStartTime,
        requestedEndTime:   l.requestedEndTime,
        excludeShiftIds:    Array.isArray(l.excludedShiftIds) ? l.excludedShiftIds : [],
        includeWeekends:    l.includeWeekends !== false,
      }).catch(() => null)
    )
  );
  return leaves.map((l, i) => ({ ...l, requestedHours: hours[i] }));
}

// ─── Replace policy IDs with human-readable names on a list of leave records ─
async function _attachPolicyNames(leaves) {
  const ids = [...new Set(leaves.map((l) => l.leaveType).filter(Boolean))];
  const policies = await prisma.leavePolicy.findMany({
    where: { id: { in: ids } },
    select: { id: true, leaveType: true },
  });
  const map = Object.fromEntries(policies.map((p) => [p.id, p.leaveType]));
  return leaves.map((l) => ({
    ..._format(l),
    leaveType: map[l.leaveType] || l.leaveType,
  }));
}

// ─── Attach deduction + cancellation transactions to a list of leave records ─
async function _attachTransactions(leaves) {
  const leaveIds = leaves.map((l) => l.id).filter(Boolean);
  if (!leaveIds.length)
    return leaves.map((l) => ({ ...l, transaction: null, cancelledAt: null, cancellation: null }));

  const txns = await prisma.leaveTransaction.findMany({
    where: { leaveId: { in: leaveIds }, type: { in: ["deduction", "cancelled"] } },
    select: {
      id:            true,
      leaveId:       true,
      type:          true,
      hours:         true,
      balanceBefore: true,
      balanceAfter:  true,
      note:          true,
      createdAt:     true,
      performedBy: {
        select: {
          id: true, email: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  const _resolvePerformedBy = (t) =>
    t.performedBy
      ? {
          id:   t.performedBy.id,
          name: t.performedBy.profile
            ? `${t.performedBy.profile.firstName || ""} ${t.performedBy.profile.lastName || ""}`.trim()
            : t.performedBy.email,
        }
      : null;

  const deductionMap  = Object.fromEntries(txns.filter((t) => t.type === "deduction").map((t) => [t.leaveId ?? "", t]));
  const cancelledMap  = Object.fromEntries(txns.filter((t) => t.type === "cancelled").map((t) => [t.leaveId ?? "", t]));

  return leaves.map((l) => {
    const t = deductionMap[l.id] ?? null;
    const c = cancelledMap[l.id] ?? null;
    return {
      ...l,
      transaction: t
        ? {
            ...t,
            hours:         Number(t.hours),
            balanceBefore: Number(t.balanceBefore),
            balanceAfter:  Number(t.balanceAfter),
            performedBy:   _resolvePerformedBy(t),
          }
        : null,
      // Populated for both self-cancel (leaveController cancelLeave) and
      // punch-wins conflict cancellation (Cutoff/leaveConflictCredit) — both
      // paths write a "cancelled" LeaveTransaction with its own createdAt.
      cancelledAt: c?.createdAt ? c.createdAt.toISOString() : null,
      cancellation: c
        ? { performedBy: _resolvePerformedBy(c), note: c.note ?? null }
        : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

const submitLeaveRequest = async (req, res) => {
  const {
    type, fromDate, toDate, approverId, leaveReason, isPaid, affectedShiftIds, fromTime, toTime,
    excludedShiftIds, includeWeekends,
  } = req.body;

  if (!type || !fromDate || !toDate || !approverId)
    return res.status(400).json({ message: "All fields are required." });

  // BB-048: optional daily time window, used as the no-shift-day fallback in
  // calcDailyHours. Both-or-neither — a lone fromTime/toTime can't express a
  // window. Same-day only (toTime after fromTime); leave requests don't model
  // a midnight-crossing window the way shifts do.
  let requestedStartTime = null;
  let requestedEndTime   = null;
  if (fromTime || toTime) {
    if (!fromTime || !toTime || !TIME_HHMM_RE.test(fromTime) || !TIME_HHMM_RE.test(toTime))
      return res.status(400).json({ message: "fromTime and toTime must both be provided in HH:MM format." });
    requestedStartTime = _parseTimeHHMM(fromTime);
    requestedEndTime   = _parseTimeHHMM(toTime);
    if (requestedEndTime <= requestedStartTime)
      return res.status(400).json({ message: "toTime must be after fromTime." });
  }

  // Normalise to YYYY-MM-DD regardless of what the client sends
  const fromDateStr = String(fromDate).slice(0, 10);
  const toDateStr   = String(toDate).slice(0, 10);

  if (fromDateStr > toDateStr)
    return res.status(400).json({ message: "From Date cannot be after To Date." });

  const requester = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { departmentId: true },
  });

  // Eligible approvers: any admin/superadmin (company-wide), or a supervisor
  // in the requester's own department. No department on the requester means
  // only admins/superadmins are selectable.
  const approverRoleConditions = [{ role: { in: ["admin", "superadmin"] } }];
  if (requester?.departmentId) {
    approverRoleConditions.push({ role: "supervisor", departmentId: requester.departmentId });
  }

  const approver = await prisma.user.findFirst({
    where: {
      id: approverId,
      companyId: req.user.companyId,
      OR: approverRoleConditions,
    },
  });
  if (!approver)
    return res.status(400).json({ message: "Invalid approver selected." });
  if (approverId === req.user.id)
    return res.status(400).json({ message: "Cannot set yourself as approver." });

  const [policy, company] = await Promise.all([
    prisma.leavePolicy.findFirst({ where: { companyId: req.user.companyId, leaveType: type } }),
    prisma.company.findUnique({ where: { id: req.user.companyId }, select: { timeZone: true } }),
  ]);
  if (!policy)
    return res.status(400).json({ message: "Leave policy not found for this type." });

  // Archived types are retired from future use — reject even if the client
  // has a stale cached list that still shows it.
  if (policy.isArchived)
    return res.status(400).json({ message: "This leave type has been archived and can no longer be used." });

  // Assignment gate — employee must be assigned to this leave type
  if (!policy.assignedToAll) {
    const assigned = await prisma.leavePolicyAssignment.findFirst({
      where: { policyId: policy.id, userId: req.user.id },
    });
    if (!assigned)
      return res.status(403).json({ message: "You are not assigned to this leave type." });
  }

  // Pay-mode intent — must be permitted by the policy's isPaid/isNotPaid gates
  const payModeIntent = isPaid !== undefined ? Boolean(isPaid) : true;
  if (payModeIntent && !policy.isPaid)
    return res.status(400).json({ message: "This leave type cannot be requested as paid." });
  if (!payModeIntent && !policy.isNotPaid)
    return res.status(400).json({ message: "This leave type cannot be requested as unpaid." });

  const companyTz = company?.timeZone || "America/Los_Angeles";
  // Store dates as noon in company timezone — prevents UTC conversion from drifting
  // the date across a day boundary for any timezone offset (UTC-12 to UTC+12).
  const startDateUTC = moment.tz(fromDateStr, companyTz).hour(12).minute(0).second(0).millisecond(0).toISOString();
  const endDateUTC   = moment.tz(toDateStr,   companyTz).hour(12).minute(0).second(0).millisecond(0).toISOString();

  // Snapshot the affected shift details if IDs were provided
  let affectedShifts = null;
  if (Array.isArray(affectedShiftIds) && affectedShiftIds.length > 0) {
    const shifts = await prisma.userShift.findMany({
      where: { id: { in: affectedShiftIds }, userId: req.user.id },
      select: {
        id: true,
        assignedDate: true,
        shift: { select: { shiftName: true, startTime: true, endTime: true, crossesMidnight: true } },
      },
    });
    affectedShifts = shifts.map((us) => {
      const s = us.shift;
      let scheduledHours = null;
      if (s) {
        let hrs = (s.endTime.getTime() - s.startTime.getTime()) / 36e5;
        if (s.crossesMidnight || hrs < 0) hrs += 24;
        scheduledHours = +hrs.toFixed(2);
      }
      return {
        userShiftId:   us.id,
        assignedDate:  us.assignedDate,
        shiftName:     s?.shiftName ?? null,
        scheduledHours,
      };
    });
  }

  // BB-054: shifts the employee explicitly deselected on a multi-shift day —
  // actually consumed by calcDailyHours (unlike affectedShifts above, which is
  // display-only). Sanitized to ids the requester actually owns.
  let sanitizedExcludedShiftIds = [];
  if (Array.isArray(excludedShiftIds) && excludedShiftIds.length > 0) {
    const owned = await prisma.userShift.findMany({
      where:  { id: { in: excludedShiftIds }, userId: req.user.id },
      select: { id: true },
    });
    sanitizedExcludedShiftIds = owned.map((us) => us.id);
  }
  const includeWeekendsFlag = includeWeekends === false ? false : true;

  const data = await prisma.leave.create({
    data: {
      userId:     req.user.id,
      approverId: approver.id,
      policyId:   policy.id,
      leaveType:  policy.id, // legacy field — kept in sync for existing code that still reads it
      startDate:  startDateUTC,
      endDate:    endDateUTC,
      status:     "pending",
      isPaid:     payModeIntent,
      leaveReason,
      requestedStartTime,
      requestedEndTime,
      excludedShiftIds: sanitizedExcludedShiftIds,
      includeWeekends:  includeWeekendsFlag,
      ...(affectedShifts !== null && { affectedShifts }),
    },
  });

  // Leave Ledger — lifecycle event, no balance movement (hours/before/after left null)
  try {
    await prisma.leaveTransaction.create({
      data: {
        userId:        req.user.id,
        policyId:      policy.id,
        type:          "submitted",
        leaveId:       data.id,
        performedById: req.user.id,
      },
    });
  } catch (ledgerErr) {
    console.error("❌ Failed to write leave-submitted ledger entry:", ledgerErr);
  }

  // Notify eligible management users (mirrors _isEligibleApprover's pool)
  try {
    const employee = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { departmentId: true, profile: { select: { firstName: true, lastName: true } } },
    });
    const employeeName = employee?.profile
      ? `${employee.profile.firstName || ""} ${employee.profile.lastName || ""}`.trim()
      : req.user.email;
    const startDateStr = fromDateStr;
    const endDateStr   = toDateStr;

    const managementUsers = await prisma.user.findMany({
      where:  { companyId: req.user.companyId, role: { in: ["admin", "superadmin", "supervisor"] }, status: "active" },
      select: { id: true, role: true, departmentId: true },
    });
    // Same pool as _isEligibleApprover — admins/superadmins company-wide, supervisors
    // only for the requester's own department. Otherwise a supervisor in an unrelated
    // department gets notified about a request they'll never see in their pending list.
    const eligibleManagementUsers = managementUsers.filter((m) =>
      _isEligibleApprover(m.role, m.departmentId, employee?.departmentId)
    );
    await Promise.all(
      eligibleManagementUsers.map((m) =>
        createNotification({
          userId:           m.id,
          companyId:        req.user.companyId,
          departmentId:     m.departmentId,
          notificationCode: "LEAVE_REQUEST_SUBMITTED",
          title:            "Leave Request Submitted",
          message:          `${employeeName} has filed a leave request (${type}) from ${startDateStr} to ${endDateStr}.`,
          payload:          { leaveId: data.id, leaveType: type, startDate: fromDate, endDate: toDate, requesterId: req.user.id },
        })
      )
    );
  } catch (notifError) {
    console.error("❌ Failed to send leave submission notification:", notifError);
  }

  res.status(201).json({ data: _format(data) });
};

// ─────────────────────────────────────────────────────────────────────────────

// Loads a leave + the requester info needed for eligibility checks and
// notifications. Returns null if no actionable (pending/pending_secondary)
// leave exists — shared by approve/reject/preview.
async function _loadActionableLeave(leaveId) {
  const leave = await prisma.leave.findFirst({
    where: { id: leaveId, status: { in: ["pending", "pending_secondary"] } },
  });
  if (!leave) return null;

  const leaveUser = await prisma.user.findUnique({
    where:  { id: leave.userId },
    select: { departmentId: true, email: true, profile: { select: { firstName: true, lastName: true } } },
  });
  return { leave, leaveUser };
}

const approveLeave = async (req, res) => {
  const leaveId = req.params.id;
  const { approverComments, escalateTo } = req.body;

  const loaded = await _loadActionableLeave(leaveId);
  if (!loaded)
    return res.status(404).json({ message: "Leave request not found or already processed." });
  const { leave, leaveUser } = loaded;

  const actingUser = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { departmentId: true },
  });
  if (!_isEligibleApprover(req.user.role, actingUser?.departmentId, leaveUser?.departmentId))
    return res.status(403).json({ message: "You are not eligible to act on this leave request." });
  if (req.user.id === leave.userId)
    return res.status(403).json({ message: "You cannot act on your own leave request." });

  const policy = await _resolvePolicy(leave, req.user.companyId);
  if (!policy)
    return res.status(400).json({ message: "Leave policy not configured." });

  const employeeName = leaveUser?.profile
    ? `${leaveUser.profile.firstName || ""} ${leaveUser.profile.lastName || ""}`.trim()
    : leaveUser?.email;
  const startDateStr = new Date(leave.startDate).toLocaleDateString();
  const endDateStr   = new Date(leave.endDate).toLocaleDateString();
  const stage         = leave.status; // "pending" | "pending_secondary"

  // ── ESCALATE (only valid from "pending") ────────────────────────────────
  if (stage === "pending" && escalateTo) {
    const company = await prisma.company.findUnique({
      where:  { id: req.user.companyId },
      select: { multiApprovalEnabled: true },
    });
    if (!company?.multiApprovalEnabled)
      return res.status(400).json({ message: "Two-step approval is not enabled for this company." });
    if (escalateTo === req.user.id)
      return res.status(400).json({ message: "Cannot escalate to yourself." });
    if (escalateTo === leave.userId)
      return res.status(400).json({ message: "Cannot escalate to the leave requester." });

    const secondaryApprover = await prisma.user.findFirst({
      where: {
        id:        escalateTo,
        companyId: req.user.companyId,
        role:      { in: ["admin", "supervisor", "superadmin"] },
        status:    "active",
      },
      select: { id: true, departmentId: true },
    });
    if (!secondaryApprover)
      return res.status(400).json({ message: "Escalation target is not a valid active approver." });

    // Atomic claim — only succeeds if still "pending" (no one else escalated/approved first)
    const claim = await prisma.leave.updateMany({
      where: { id: leaveId, status: "pending" },
      data:  { status: "pending_secondary", secondaryApproverId: escalateTo, approverComments, escalatedByUserId: req.user.id },
    });
    if (claim.count === 0)
      return res.status(409).json({ message: "This leave request was already actioned by someone else." });

    const data = await prisma.leave.findUnique({ where: { id: leaveId } });

    try {
      await prisma.leaveTransaction.create({
        data: {
          userId:        leave.userId,
          policyId:      policy.id,
          type:          "escalated",
          leaveId,
          performedById: req.user.id,
          note:          approverComments || null,
        },
      });
    } catch (ledgerErr) {
      console.error("❌ Failed to write leave-escalated ledger entry:", ledgerErr);
    }

    try {
      // Notify the full eligible second-stage pool, not just the specifically named
      // escalateTo target — the same broadened-pool rule applies here as everywhere
      // else (any admin/superadmin, or any supervisor in the requester's department,
      // can act on a pending_secondary request, not just the person it was escalated to).
      const managementUsers = await prisma.user.findMany({
        where:  { companyId: req.user.companyId, role: { in: ["admin", "superadmin", "supervisor"] }, status: "active" },
        select: { id: true, role: true, departmentId: true },
      });
      const eligibleManagementUsers = managementUsers.filter((m) =>
        _isEligibleApprover(m.role, m.departmentId, leaveUser?.departmentId)
      );
      await Promise.all(
        eligibleManagementUsers.map((m) =>
          createNotification({
            userId:           m.id,
            companyId:        req.user.companyId,
            departmentId:     m.departmentId,
            notificationCode: "LEAVE_PENDING_SECONDARY_APPROVAL",
            title:            "Leave Request Awaiting Final Approval",
            message:          `${employeeName}'s leave request from ${startDateStr} to ${endDateStr} has been escalated and is awaiting final approval.`,
            payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate, requesterId: leave.userId },
          })
        )
      );
    } catch (e) {
      console.error("❌ Failed to send secondary approval notification:", e);
    }

    try {
      await createNotification({
        userId:           leave.userId,
        companyId:        req.user.companyId,
        departmentId:     leaveUser?.departmentId || null,
        notificationCode: "LEAVE_REQUEST_FIRST_APPROVED",
        title:            "Leave Request — First Approval Done",
        message:          `Your leave request from ${startDateStr} to ${endDateStr} has been approved by your supervisor and is awaiting final approval.`,
        payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate },
      });
    } catch (e) {
      console.error("❌ Failed to send first-approval employee notification:", e);
    }

    return res.json({ data: _format(data) });
  }

  // ── FINAL APPROVAL — from "pending" (no escalation) or "pending_secondary" ─
  // Atomic claim first: flips status only if it's still in the expected stage,
  // so two eligible approvers acting at the same time can't both succeed.
  const claim = await prisma.leave.updateMany({
    where: { id: leaveId, status: stage },
    data:  stage === "pending_secondary"
      ? { status: "approved", secondaryApproverComments: approverComments, decidedByUserId: req.user.id }
      : { status: "approved", approverComments, decidedByUserId: req.user.id },
  });
  if (claim.count === 0)
    return res.status(409).json({ message: "This leave request was already actioned by someone else." });

  try {
    await applyLeaveApproval(leave, policy, req.user.id, approverComments);
  } catch (err) {
    // Compensate — release the claim so the leave isn't stuck "approved" with no ledger effect
    await prisma.leave.update({ where: { id: leaveId }, data: { status: stage } }).catch(() => {});
    console.error("❌ Failed to apply leave approval ledger:", err);
    return res.status(500).json({ message: "Failed to finalize leave approval. Please try again." });
  }

  const data = await prisma.leave.findUnique({ where: { id: leaveId } });

  try {
    await createNotification({
      userId:           leave.userId,
      companyId:        req.user.companyId,
      departmentId:     leaveUser?.departmentId || null,
      notificationCode: "LEAVE_REQUEST_APPROVED",
      title:            "Leave Request Approved",
      message:          stage === "pending_secondary"
        ? `Your leave request from ${startDateStr} to ${endDateStr} has been fully approved.`
        : `Your leave request from ${startDateStr} to ${endDateStr} has been approved.`,
      payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate },
    });
  } catch (e) {
    console.error("❌ Failed to send leave approval notification:", e);
  }

  try {
    getIO().to(leave.userId).emit("leaveBalanceUpdated", { leaveId, policyId: policy.id });
  } catch (_) {}

  return res.json({ data: _format(data) });
};

// ─────────────────────────────────────────────────────────────────────────────

const rejectLeave = async (req, res) => {
  const leaveId = req.params.id;
  const { approverComments } = req.body;

  const loaded = await _loadActionableLeave(leaveId);
  if (!loaded)
    return res.status(404).json({ message: "Leave request not found or already processed." });
  const { leave, leaveUser } = loaded;

  const actingUser = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { departmentId: true },
  });
  if (!_isEligibleApprover(req.user.role, actingUser?.departmentId, leaveUser?.departmentId))
    return res.status(403).json({ message: "You are not eligible to act on this leave request." });
  if (req.user.id === leave.userId)
    return res.status(403).json({ message: "You cannot act on your own leave request." });

  const stage = leave.status; // "pending" | "pending_secondary"

  const claim = await prisma.leave.updateMany({
    where: { id: leaveId, status: stage },
    data:  stage === "pending_secondary"
      ? { status: "rejected", secondaryApproverComments: approverComments, decidedByUserId: req.user.id }
      : { status: "rejected", approverComments, decidedByUserId: req.user.id },
  });
  if (claim.count === 0)
    return res.status(409).json({ message: "This leave request was already actioned by someone else." });

  const data = await prisma.leave.findUnique({ where: { id: leaveId } });

  try {
    const policy = await _resolvePolicy(leave, req.user.companyId);
    await prisma.leaveTransaction.create({
      data: {
        userId:        leave.userId,
        policyId:      policy?.id ?? leave.policyId,
        type:          "rejected",
        leaveId,
        performedById: req.user.id,
        note:          approverComments || null,
      },
    });
  } catch (ledgerErr) {
    console.error("❌ Failed to write leave-rejected ledger entry:", ledgerErr);
  }

  try {
    const startDateStr = new Date(leave.startDate).toLocaleDateString();
    const endDateStr   = new Date(leave.endDate).toLocaleDateString();
    await createNotification({
      userId:           leave.userId,
      companyId:        req.user.companyId,
      departmentId:     leaveUser?.departmentId || null,
      notificationCode: "LEAVE_REQUEST_REJECTED",
      title:            "Leave Request Rejected",
      message:          `Your leave request from ${startDateStr} to ${endDateStr} has been rejected.`,
      payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate },
    });
  } catch (notifError) {
    console.error("❌ Failed to send leave rejection notification:", notifError);
  }

  res.json({ data: _format(data) });
};

// ─────────────────────────────────────────────────────────────────────────────

// Requester withdraws their own request while it's still undecided. No
// balance/ledger writes — deduction only ever happens at approval (§6), so a
// pending/pending_secondary leave has no balance movement to reverse. The
// retained Leave record (status: "cancelled") is the audit trail, same as
// rejection already relies on — no ledger entry, same reasoning.
const cancelLeave = async (req, res) => {
  const leaveId = req.params.id;

  const loaded = await _loadActionableLeave(leaveId);
  if (!loaded)
    return res.status(404).json({ message: "Leave request not found or already processed." });
  const { leave, leaveUser } = loaded;

  if (leave.userId !== req.user.id)
    return res.status(403).json({ message: "You can only cancel your own leave request." });

  const claim = await prisma.leave.updateMany({
    where: { id: leaveId, status: leave.status },
    data:  { status: "cancelled" },
  });
  if (claim.count === 0)
    return res.status(409).json({ message: "This leave request was already actioned by someone else." });

  const data = await prisma.leave.findUnique({ where: { id: leaveId } });

  try {
    const policy = await _resolvePolicy(leave, req.user.companyId);
    await prisma.leaveTransaction.create({
      data: {
        userId:        leave.userId,
        policyId:      policy?.id ?? leave.policyId,
        type:          "cancelled",
        leaveId,
        performedById: req.user.id,
      },
    });
  } catch (ledgerErr) {
    console.error("❌ Failed to write leave-cancelled ledger entry:", ledgerErr);
  }

  try {
    const employeeName = leaveUser?.profile
      ? `${leaveUser.profile.firstName || ""} ${leaveUser.profile.lastName || ""}`.trim()
      : leaveUser?.email;
    const startDateStr = new Date(leave.startDate).toLocaleDateString();
    const endDateStr   = new Date(leave.endDate).toLocaleDateString();

    const managementUsers = await prisma.user.findMany({
      where:  { companyId: req.user.companyId, role: { in: ["admin", "superadmin", "supervisor"] }, status: "active" },
      select: { id: true, role: true, departmentId: true },
    });
    // Same eligible pool as submit's notification — admins/superadmins
    // company-wide, supervisors only for the requester's own department.
    const eligibleManagementUsers = managementUsers.filter((m) =>
      _isEligibleApprover(m.role, m.departmentId, leaveUser?.departmentId)
    );
    await Promise.all(
      eligibleManagementUsers.map((m) =>
        createNotification({
          userId:           m.id,
          companyId:        req.user.companyId,
          departmentId:     m.departmentId,
          notificationCode: "LEAVE_REQUEST_CANCELLED",
          title:            "Leave Request Cancelled",
          message:          `${employeeName} cancelled their leave request from ${startDateStr} to ${endDateStr}.`,
          payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate, requesterId: leave.userId },
        })
      )
    );
  } catch (notifError) {
    console.error("❌ Failed to send leave cancellation notification:", notifError);
  }

  res.json({ data: _format(data) });
};

// ─────────────────────────────────────────────────────────────────────────────

const previewApproval = async (req, res) => {
  const leaveId = req.params.id;

  const loaded = await _loadActionableLeave(leaveId);
  if (!loaded)
    return res.status(404).json({ message: "Leave request not found or already processed." });
  const { leave, leaveUser } = loaded;

  const actingUser = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { departmentId: true },
  });
  if (!_isEligibleApprover(req.user.role, actingUser?.departmentId, leaveUser?.departmentId))
    return res.status(403).json({ message: "You are not eligible to act on this leave request." });
  if (req.user.id === leave.userId)
    return res.status(403).json({ message: "You cannot act on your own leave request." });

  const policy = await _resolvePolicy(leave, req.user.companyId);
  if (!policy)
    return res.status(400).json({ message: "Leave policy not configured." });

  const preview = await previewLeaveApproval(leave, policy);
  res.json({ data: preview });
};

// ─────────────────────────────────────────────────────────────────────────────

// Post-decision day-level breakdown (LeaveDay rows written at approval time,
// see leaveApprovalService.applyLeaveApproval) — complements previewApproval,
// which is the pre-decision equivalent. Visible to the requester themselves,
// or management under the same rule as leaveVisibilityWhere (admin company-
// wide, supervisor own-department only).
const getLeaveDays = async (req, res) => {
  const leaveId = req.params.id;

  const leave = await prisma.leave.findUnique({
    where:  { id: leaveId },
    select: { id: true, userId: true },
  });
  if (!leave) return res.status(404).json({ message: "Leave request not found." });

  if (leave.userId !== req.user.id) {
    const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);
    if (!isManagement)
      return res.status(403).json({ message: "Not authorized to view this leave." });

    const leaveUser = await prisma.user.findUnique({
      where:  { id: leave.userId },
      select: { departmentId: true, companyId: true },
    });
    if (leaveUser?.companyId !== req.user.companyId)
      return res.status(404).json({ message: "Leave request not found." });

    if (req.user.role === "supervisor") {
      const actingUser = await prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { departmentId: true },
      });
      if (!actingUser?.departmentId || actingUser.departmentId !== leaveUser?.departmentId)
        return res.status(403).json({ message: "Not authorized to view this leave." });
    }
  }

  const days = await prisma.leaveDay.findMany({
    where:   { leaveId },
    // BB-045: a day that got split by proration has two rows sharing the same
    // date (one paid, one unpaid) — order isPaid desc so the paid portion is
    // always listed first for a split date.
    orderBy: [{ date: "asc" }, { isPaid: "desc" }],
  });

  res.json({
    data: days.map((d) => ({
      date:   d.date.toISOString().slice(0, 10),
      isPaid: d.isPaid,
      hours:  Number(d.hours),
    })),
  });
};

// ─────────────────────────────────────────────────────────────────────────────

const getUserLeaves = async (req, res) => {
  const leaves = await prisma.leave.findMany({
    where:   { userId: req.user.id },
    include: {
      approver: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      escalatedBy: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      decidedBy: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { startDate: "desc" },
  });

  const withNames = await _attachPolicyNames(leaves);
  const withHours = await _attachRequestedHours(withNames);
  const withTxns  = await _attachTransactions(withHours);
  const data = withTxns.map((l) => {
    const raw = leaves.find((r) => r.id === l.id);
    return {
      ...l,
      approver: raw?.approver
        ? {
            ...raw.approver,
            name: raw.approver.profile
              ? `${raw.approver.profile.firstName || ""} ${raw.approver.profile.lastName || ""}`.trim()
              : raw.approver.username,
          }
        : null,
      escalatedBy: raw?.escalatedBy
        ? {
            ...raw.escalatedBy,
            name: raw.escalatedBy.profile
              ? `${raw.escalatedBy.profile.firstName || ""} ${raw.escalatedBy.profile.lastName || ""}`.trim()
              : raw.escalatedBy.username,
          }
        : null,
      decidedBy: raw?.decidedBy
        ? {
            ...raw.decidedBy,
            name: raw.decidedBy.profile
              ? `${raw.decidedBy.profile.firstName || ""} ${raw.decidedBy.profile.lastName || ""}`.trim()
              : raw.decidedBy.username,
          }
        : null,
    };
  });

  res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

const getPendingLeavesForApprover = async (req, res) => {
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  // Management roles: company-wide for admin/superadmin, own-department only
  // for supervisors (view-only for leaves not directed at them — see canAct below)
  let where;
  let actingDepartmentId = null;
  if (isManagement) {
    const requester = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { departmentId: true },
    });
    actingDepartmentId = requester?.departmentId ?? null;
    where = {
      ...leaveVisibilityWhere(req.user.companyId, req.user.role, actingDepartmentId),
      status: { in: ["pending", "pending_secondary"] },
    };
  } else {
    where = {
      OR: [
        { approverId:          req.user.id, status: "pending"           },
        { secondaryApproverId: req.user.id, status: "pending_secondary" },
      ],
    };
  }

  const leaves = await prisma.leave.findMany({
    where,
    include: {
      User: {
        select: {
          id: true, email: true, username: true, role: true, departmentId: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      approver: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      escalatedBy: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      decidedBy: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const withNames = await _attachPolicyNames(leaves);
  const withHours = await _attachRequestedHours(withNames);
  const withTxns  = await _attachTransactions(withHours);
  const data = withTxns.map((l) => {
    const raw = leaves.find((r) => r.id === l.id);
    // Eligibility mirrors the actual approve/reject/escalate guard (_isEligibleApprover
    // above) — being the named approver is a default, not exclusive, for management roles.
    const canAct = isManagement
      ? ["pending", "pending_secondary"].includes(raw.status) &&
        raw.User?.id !== req.user.id &&
        _isEligibleApprover(req.user.role, actingDepartmentId, raw.User?.departmentId)
      : (raw.status === "pending"           && raw.approverId          === req.user.id) ||
        (raw.status === "pending_secondary" && raw.secondaryApproverId === req.user.id);
    return {
      ...l,
      canAct,
      requester: raw?.User
        ? {
            ...raw.User,
            name: raw.User.profile
              ? `${raw.User.profile.firstName || ""} ${raw.User.profile.lastName || ""}`.trim()
              : raw.User.username,
          }
        : null,
      approver: raw?.approver
        ? {
            ...raw.approver,
            name: raw.approver.profile
              ? `${raw.approver.profile.firstName || ""} ${raw.approver.profile.lastName || ""}`.trim()
              : raw.approver.username,
          }
        : null,
      escalatedBy: raw?.escalatedBy
        ? {
            ...raw.escalatedBy,
            name: raw.escalatedBy.profile
              ? `${raw.escalatedBy.profile.firstName || ""} ${raw.escalatedBy.profile.lastName || ""}`.trim()
              : raw.escalatedBy.username,
          }
        : null,
      decidedBy: raw?.decidedBy
        ? {
            ...raw.decidedBy,
            name: raw.decidedBy.profile
              ? `${raw.decidedBy.profile.firstName || ""} ${raw.decidedBy.profile.lastName || ""}`.trim()
              : raw.decidedBy.username,
          }
        : null,
    };
  });

  res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

const getLeavesForApprover = async (req, res) => {
  const { status } = req.query;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  const validStatuses = ["pending", "pending_secondary", "approved", "rejected", "cancelled"];
  if (status && !validStatuses.includes(status.toLowerCase()))
    return res.status(400).json({ message: "Invalid status filter." });

  // Management roles: company-wide for admin/superadmin, own-department only
  // for supervisors, all statuses (view-only unless directed at them)
  let where;
  let actingDepartmentId = null;
  if (isManagement) {
    const requester = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { departmentId: true },
    });
    actingDepartmentId = requester?.departmentId ?? null;
    where = {
      ...leaveVisibilityWhere(req.user.companyId, req.user.role, actingDepartmentId),
      ...(status ? { status: status.toLowerCase() } : {}),
    };
  } else {
    where = {
      OR: [
        { approverId:          req.user.id },
        { secondaryApproverId: req.user.id },
      ],
      ...(status ? { status: status.toLowerCase() } : {}),
    };
  }

  const [leaves, total] = await Promise.all([
    prisma.leave.findMany({
      where,
      include: {
        User: {
          select: {
            id: true, email: true, username: true, role: true, departmentId: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        approver: {
          select: {
            id: true, email: true, username: true, role: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        escalatedBy: {
          select: {
            id: true, email: true, username: true, role: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        decidedBy: {
          select: {
            id: true, email: true, username: true, role: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { startDate: "desc" },
      take:    limit,
      skip:    offset,
    }),
    prisma.leave.count({ where }),
  ]);

  const withNames = await _attachPolicyNames(leaves);
  const withHours = await _attachRequestedHours(withNames);
  const withTxns  = await _attachTransactions(withHours);
  const data = withTxns.map((l) => {
    const raw = leaves.find((r) => r.id === l.id);
    // Eligibility mirrors the actual approve/reject/escalate guard (_isEligibleApprover
    // above) — being the named approver is a default, not exclusive, for management roles.
    const canAct = isManagement
      ? ["pending", "pending_secondary"].includes(raw.status) &&
        raw.User?.id !== req.user.id &&
        _isEligibleApprover(req.user.role, actingDepartmentId, raw.User?.departmentId)
      : (raw.status === "pending"           && raw.approverId          === req.user.id) ||
        (raw.status === "pending_secondary" && raw.secondaryApproverId === req.user.id);
    return {
      ...l,
      canAct,
      requester: raw?.User
        ? {
            ...raw.User,
            name: raw.User.profile
              ? `${raw.User.profile.firstName || ""} ${raw.User.profile.lastName || ""}`.trim()
              : raw.User.username,
          }
        : null,
      approver: raw?.approver
        ? {
            ...raw.approver,
            name: raw.approver.profile
              ? `${raw.approver.profile.firstName || ""} ${raw.approver.profile.lastName || ""}`.trim()
              : raw.approver.username,
          }
        : null,
      escalatedBy: raw?.escalatedBy
        ? {
            ...raw.escalatedBy,
            name: raw.escalatedBy.profile
              ? `${raw.escalatedBy.profile.firstName || ""} ${raw.escalatedBy.profile.lastName || ""}`.trim()
              : raw.escalatedBy.username,
          }
        : null,
      decidedBy: raw?.decidedBy
        ? {
            ...raw.decidedBy,
            name: raw.decidedBy.profile
              ? `${raw.decidedBy.profile.firstName || ""} ${raw.decidedBy.profile.lastName || ""}`.trim()
              : raw.decidedBy.username,
          }
        : null,
    };
  });

  res.json({ data, pagination: { total, limit, offset, hasMore: offset + limit < total } });
};

// ─────────────────────────────────────────────────────────────────────────────

const getApprovers = async (req, res) => {
  // Same eligible-approver rule as submitLeaveRequest: admins/superadmins
  // company-wide, supervisors restricted to the requester's own department.
  const data = await getEligibleApprovers({ id: req.user.id, companyId: req.user.companyId });
  res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

const deleteLeave = async (req, res) => {
  const leaveId = req.params.id;
  const leave = await prisma.leave.findFirst({
    where: { id: leaveId, approverId: req.user.id },
  });
  if (!leave)
    return res.status(404).json({ message: "Leave request not found." });
  await prisma.leave.delete({ where: { id: leaveId } });
  res.json({ message: "deleted" });
};

// ─────────────────────────────────────────────────────────────────────────────

const getBalance = async (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ message: "type is required" });

  const policies = await prisma.leavePolicy.findMany({
    where:   { companyId: req.user.companyId, leaveType: type },
    include: { company: true },
  });
  if (!policies.length)
    return res.status(404).json({ message: "Leave policy not found" });

  let total = 0;
  for (const p of policies) {
    const bal = await prisma.leaveBalance.findFirst({
      where: { userId: req.user.id, policyId: p.id },
    });
    total += bal ? Number(bal.balanceHours) : 0;
  }

  res.json({
    data: {
      leaveType:    type,
      balanceHours: total,
      shiftHours:   Number(policies[0].company.defaultShiftHours || 8),
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────

const listBalances = async (req, res) => {
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  let targetUserId = req.user.id;
  if (isManagement && req.query.userId) {
    const member = await prisma.user.findFirst({
      where: { id: req.query.userId, companyId: req.user.companyId },
      select: { id: true },
    });
    if (!member) return res.status(404).json({ message: "User not found in this company." });
    targetUserId = member.id;
  }

  const policies = await prisma.leavePolicy.findMany({
    where:   { companyId: req.user.companyId },
    include: { company: true, balances: { where: { userId: targetUserId } } },
  });

  const policyIds = policies.map((p) => p.id);

  const [recentTxns, deductionTotals] = await Promise.all([
    prisma.leaveTransaction.findMany({
      where:   { userId: targetUserId, policyId: { in: policyIds } },
      orderBy: { createdAt: "desc" },
      take:    100,
      select: {
        id:            true,
        policyId:      true,
        type:          true,
        hours:         true,
        balanceBefore: true,
        balanceAfter:  true,
        leaveId:       true,
        note:          true,
        createdAt:     true,
      },
    }),
    prisma.leaveTransaction.groupBy({
      by:    ["policyId"],
      where: { userId: targetUserId, policyId: { in: policyIds }, type: "deduction" },
      _sum:  { hours: true },
    }),
  ]);

  const usedMap = Object.fromEntries(
    deductionTotals.map((d) => [d.policyId, Math.abs(Number(d._sum.hours ?? 0))])
  );

  const txnsByPolicy = {};
  recentTxns.forEach((t) => {
    if (!txnsByPolicy[t.policyId]) txnsByPolicy[t.policyId] = [];
    txnsByPolicy[t.policyId].push({
      ...t,
      hours:         Number(t.hours),
      balanceBefore: Number(t.balanceBefore),
      balanceAfter:  Number(t.balanceAfter),
    });
  });

  const map = {};
  policies.forEach((p) => {
    // "available" is the running balance (kept in sync on every write since
    // Phase 4's atomic ledger writer). "used" is summed straight from the
    // ledger's deduction transactions, not a separately-tracked field, so it
    // can't drift from what was actually approved. "credits" is derived —
    // available + used — rather than independently summed, so the three
    // numbers can never fail to reconcile (Credits - Used = Available by
    // construction). See docs/LEAVE_MODULE.md §4, §14e.
    const available = p.balances.reduce((s, b) => s + Number(b.balanceHours), 0);
    const used      = usedMap[p.id] ?? 0;
    const credits   = +(available + used).toFixed(2);

    map[p.leaveType] = {
      policyId:     p.id,
      leaveType:    p.leaveType,
      isPaid:       p.isPaid,
      isNotPaid:    p.isNotPaid,
      credits,
      used,
      available,
      // Legacy field names — kept for existing clients, equal to available/used above.
      balanceHours: available,
      usedHours:    used,
      shiftHours:   Number(p.company.defaultShiftHours || 8),
      transactions: txnsByPolicy[p.id] ?? [],
    };
  });
  res.json({ data: Object.values(map) });
};

// ─────────────────────────────────────────────────────────────────────────────

const getAffectedSchedules = async (req, res) => {
  const { startDate, endDate, fromTime, toTime, includeWeekends } = req.query;
  // BB-054: query params arrive as strings — only the literal "false" opts out.
  const includeWeekendsFlag = includeWeekends === "false" ? false : true;

  if (!startDate || !endDate)
    return res.status(400).json({ message: "startDate and endDate are required." });

  if (new Date(startDate) > new Date(endDate))
    return res.status(400).json({ message: "startDate cannot be after endDate." });

  // BB-048: optional daily time window — same validation as submitLeaveRequest.
  let requestedStartTime = null;
  let requestedEndTime   = null;
  if (fromTime || toTime) {
    if (!fromTime || !toTime || !TIME_HHMM_RE.test(fromTime) || !TIME_HHMM_RE.test(toTime))
      return res.status(400).json({ message: "fromTime and toTime must both be provided in HH:MM format." });
    requestedStartTime = _parseTimeHHMM(fromTime);
    requestedEndTime   = _parseTimeHHMM(toTime);
    if (requestedEndTime <= requestedStartTime)
      return res.status(400).json({ message: "toTime must be after fromTime." });
  }

  const userShifts = await prisma.userShift.findMany({
    where: {
      userId:       req.user.id,
      assignedDate: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
      status: { not: "cancelled" },
    },
    select: {
      id:          true,
      assignedDate: true,
      shift: {
        select: {
          shiftName:      true,
          startTime:      true,
          endTime:        true,
          crossesMidnight: true,
        },
      },
    },
    orderBy: { assignedDate: "asc" },
  });

  const data = userShifts.map((us) => {
    const s = us.shift;
    let scheduledHours = null;
    if (s) {
      let hrs = (s.endTime.getTime() - s.startTime.getTime()) / 36e5;
      if (s.crossesMidnight || hrs < 0) hrs += 24;
      scheduledHours = +hrs.toFixed(2);
    }
    return {
      userShiftId:    us.id,
      assignedDate:   us.assignedDate,
      shiftName:      s?.shiftName ?? null,
      startTime:      s?.startTime ?? null,
      endTime:        s?.endTime ?? null,
      crossesMidnight: s?.crossesMidnight ?? false,
      scheduledHours,
      isFallback:     false,
    };
  });

  // BB-048: mirror calcDailyHours' no-shift fallback here so this pre-submission
  // preview matches what actually gets deducted at approval time. calcDailyHours
  // now returns a fallback entry for every no-shift day, including inside a
  // mixed range (some days scheduled, some not) — no rest-day distinction.
  const matchedDates = new Set(data.map((d) => d.assignedDate.toISOString().split("T")[0]));
  const dailyHours = await calcDailyHours(req.user.id, startDate, endDate, {
    requestedStartTime,
    requestedEndTime,
    includeWeekends: includeWeekendsFlag,
  }).catch(() => []);

  for (const day of dailyHours) {
    if (matchedDates.has(day.date)) continue;
    // BB-054: a 0h fallback day only happens here when includeWeekends=false
    // zeroed out an unplotted Sat/Sun — flag it so the client can render the
    // excluded row without independently recomputing which dates are weekends.
    const dow = new Date(`${day.date}T00:00:00.000Z`).getUTCDay();
    const excludedByWeekend = includeWeekendsFlag === false && (dow === 0 || dow === 6) && day.hours === 0;
    data.push({
      userShiftId:     null,
      assignedDate:    new Date(`${day.date}T00:00:00.000Z`),
      shiftName:        null,
      startTime:        null,
      endTime:          null,
      crossesMidnight:  false,
      scheduledHours:   day.hours,
      isFallback:       true,
      excludedByWeekend,
    });
  }
  data.sort((a, b) => a.assignedDate - b.assignedDate);

  return res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  submitLeaveRequest,
  getUserLeaves,
  getPendingLeavesForApprover,
  approveLeave,
  rejectLeave,
  cancelLeave,
  previewApproval,
  getLeaveDays,
  getApprovers,
  deleteLeave,
  getLeavesForApprover,
  getBalance,
  listBalances,
  getAffectedSchedules,
};
