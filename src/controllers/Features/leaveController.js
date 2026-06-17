// src/controllers/Features/leaveController.js

const { prisma } = require("@config/connection");
const { calcRequestedHours } = require("@utils/leaveUtils");
const { createNotification } = require("@services/notificationService");
const { getIO } = require("@config/socket");

const _format = (l) => ({
  ...l,
  startDate: l.startDate.toISOString().slice(0, 10),
  endDate:   l.endDate.toISOString().slice(0, 10),
  createdAt: l.createdAt.toISOString(),
  updatedAt: l.updatedAt.toISOString(),
});

// ─── Resolve a leave policy from a leave record (ID first, name fallback) ────
async function _resolvePolicy(leaveType, companyId) {
  let policy = await prisma.leavePolicy.findFirst({ where: { id: leaveType } });
  if (!policy) {
    policy = await prisma.leavePolicy.findFirst({
      where: { companyId, leaveType },
    });
  }
  return policy;
}

// ─── Attach requestedHours to a list of already-formatted leave records ───────
async function _attachRequestedHours(leaves) {
  const hours = await Promise.all(
    leaves.map((l) =>
      calcRequestedHours(l.userId, l.startDate, l.endDate).catch(() => null)
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

// ─── Deduct leave balance (shared between single and final approval) ──────────
async function _deductBalance(leave, policy, companyId) {
  // Unpaid leave — no balance deduction needed
  if (!leave.isPaid) return { error: false, requestedHours: 0 };

  const requestedHours = await calcRequestedHours(
    leave.userId,
    leave.startDate,
    leave.endDate
  );

  const bal = await prisma.leaveBalance.upsert({
    where:  { userId_policyId: { userId: leave.userId, policyId: policy.id } },
    update: {},
    create: { userId: leave.userId, policyId: policy.id, balanceHours: 0 },
  });

  if (!policy.negativeAllowed && Number(bal.balanceHours) < requestedHours) {
    return {
      error: true,
      message: `Insufficient leave balance (${bal.balanceHours}h available, ${requestedHours}h needed).`,
      debug: { available: bal.balanceHours, requested: requestedHours, leaveType: policy.leaveType },
    };
  }

  await prisma.leaveBalance.update({
    where: { id: bal.id },
    data:  { balanceHours: { decrement: requestedHours } },
  });

  return { error: false, requestedHours };
}

// ─────────────────────────────────────────────────────────────────────────────

const submitLeaveRequest = async (req, res) => {
  const { type, fromDate, toDate, approverId, leaveReason, isPaid, affectedShiftIds } = req.body;

  if (!type || !fromDate || !toDate || !approverId)
    return res.status(400).json({ message: "All fields are required." });

  if (new Date(fromDate) > new Date(toDate))
    return res.status(400).json({ message: "From Date cannot be after To Date." });

  const approver = await prisma.user.findFirst({
    where: {
      id: approverId,
      companyId: req.user.companyId,
      role: { in: ["admin", "supervisor", "superadmin"] },
    },
  });
  if (!approver)
    return res.status(400).json({ message: "Invalid approver selected." });
  if (approverId === req.user.id)
    return res.status(400).json({ message: "Cannot set yourself as approver." });

  const policy = await prisma.leavePolicy.findFirst({
    where: { companyId: req.user.companyId, leaveType: type },
  });
  if (!policy)
    return res.status(400).json({ message: "Leave policy not found for this type." });

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

  const data = await prisma.leave.create({
    data: {
      userId:     req.user.id,
      approverId: approver.id,
      leaveType:  policy.id,
      startDate:  new Date(fromDate).toISOString(),
      endDate:    new Date(toDate).toISOString(),
      status:     "pending",
      isPaid:     isPaid !== undefined ? Boolean(isPaid) : true,
      leaveReason,
      ...(affectedShifts !== null && { affectedShifts }),
    },
  });

  // Notify all management users
  try {
    const employee = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { profile: { select: { firstName: true, lastName: true } } },
    });
    const employeeName = employee?.profile
      ? `${employee.profile.firstName || ""} ${employee.profile.lastName || ""}`.trim()
      : req.user.email;
    const startDateStr = new Date(fromDate).toLocaleDateString();
    const endDateStr   = new Date(toDate).toLocaleDateString();

    const managementUsers = await prisma.user.findMany({
      where:  { companyId: req.user.companyId, role: { in: ["admin", "superadmin", "supervisor"] }, status: "active" },
      select: { id: true, departmentId: true },
    });
    await Promise.all(
      managementUsers.map((m) =>
        createNotification({
          userId:           m.id,
          companyId:        req.user.companyId,
          departmentId:     m.departmentId,
          notificationCode: "LEAVE_REQUEST_SUBMITTED",
          title:            "Leave Request Submitted",
          message:          `${employeeName} submitted a leave request (${type}) from ${startDateStr} to ${endDateStr}.`,
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

const approveLeave = async (req, res) => {
  const leaveId = req.params.id;
  const { approverComments, escalateTo } = req.body;

  // Find leave where the caller is either the first approver (pending)
  // or the secondary approver (pending_secondary)
  const leave = await prisma.leave.findFirst({
    where: {
      id: leaveId,
      OR: [
        { approverId:          req.user.id, status: "pending"           },
        { secondaryApproverId: req.user.id, status: "pending_secondary" },
      ],
    },
  });

  if (!leave)
    return res.status(404).json({ message: "Leave request not found or already processed." });

  const isFirstApprover     = leave.status === "pending"           && leave.approverId          === req.user.id;
  const isSecondaryApprover = leave.status === "pending_secondary" && leave.secondaryApproverId === req.user.id;

  const policy = await _resolvePolicy(leave.leaveType, req.user.companyId);
  if (!policy)
    return res.status(400).json({ message: "Leave policy not configured." });

  const leaveUser = await prisma.user.findUnique({
    where:  { id: leave.userId },
    select: {
      departmentId: true,
      email:        true,
      profile:      { select: { firstName: true, lastName: true } },
    },
  });
  const employeeName = leaveUser?.profile
    ? `${leaveUser.profile.firstName || ""} ${leaveUser.profile.lastName || ""}`.trim()
    : leaveUser?.email;
  const startDateStr = new Date(leave.startDate).toLocaleDateString();
  const endDateStr   = new Date(leave.endDate).toLocaleDateString();

  // ── FIRST APPROVER ────────────────────────────────────────────────────────
  if (isFirstApprover) {
    // Check if approver wants to escalate to a second approver.
    // Requires: company.multiApprovalEnabled = true AND a valid escalateTo userId.
    if (escalateTo) {
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

      // Step 1 of 2 — set secondaryApproverId per-request, advance to pending_secondary
      const data = await prisma.leave.update({
        where: { id: leaveId },
        data:  { status: "pending_secondary", secondaryApproverId: escalateTo, approverComments },
      });

      try {
        await createNotification({
          userId:           escalateTo,
          companyId:        req.user.companyId,
          departmentId:     secondaryApprover.departmentId || null,
          notificationCode: "LEAVE_PENDING_SECONDARY_APPROVAL",
          title:            "Leave Request Awaiting Your Approval",
          message:          `${employeeName}'s leave request from ${startDateStr} to ${endDateStr} has been approved by the first approver and is awaiting your final approval.`,
          payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate, requesterId: leave.userId },
        });
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

    // No escalation — single approver, deduct balance and fully approve
    const result = await _deductBalance(leave, policy, req.user.companyId);
    if (result.error) return res.status(400).json({ message: result.message, debug: result.debug });

    const data = await prisma.leave.update({
      where: { id: leaveId },
      data:  { status: "approved", approverComments },
    });

    // Notify employee + emit real-time balance update
    try {
      await createNotification({
        userId:           leave.userId,
        companyId:        req.user.companyId,
        departmentId:     leaveUser?.departmentId || null,
        notificationCode: "LEAVE_REQUEST_APPROVED",
        title:            "Leave Request Approved",
        message:          `Your leave request from ${startDateStr} to ${endDateStr} has been approved.`,
        payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate },
      });
    } catch (e) {
      console.error("❌ Failed to send leave approval notification:", e);
    }

    try {
      getIO().to(leave.userId).emit("leaveBalanceUpdated", { leaveId, policyId: policy.id });
    } catch (_) {}

    return res.json({ data: _format(data) });
  }

  // ── SECONDARY (FINAL) APPROVER ────────────────────────────────────────────
  if (isSecondaryApprover) {
    const result = await _deductBalance(leave, policy, req.user.companyId);
    if (result.error) return res.status(400).json({ message: result.message, debug: result.debug });

    const data = await prisma.leave.update({
      where: { id: leaveId },
      data:  { status: "approved", secondaryApproverComments: approverComments },
    });

    try {
      await createNotification({
        userId:           leave.userId,
        companyId:        req.user.companyId,
        departmentId:     leaveUser?.departmentId || null,
        notificationCode: "LEAVE_REQUEST_APPROVED",
        title:            "Leave Request Approved",
        message:          `Your leave request from ${startDateStr} to ${endDateStr} has been fully approved.`,
        payload:          { leaveId, startDate: leave.startDate, endDate: leave.endDate },
      });
    } catch (e) {
      console.error("❌ Failed to send final approval notification:", e);
    }

    try {
      getIO().to(leave.userId).emit("leaveBalanceUpdated", { leaveId, policyId: policy.id });
    } catch (_) {}

    return res.json({ data: _format(data) });
  }
};

// ─────────────────────────────────────────────────────────────────────────────

const rejectLeave = async (req, res) => {
  const leaveId = req.params.id;
  const { approverComments } = req.body;

  // Either first approver rejecting a pending leave,
  // or secondary approver rejecting a pending_secondary leave
  const leave = await prisma.leave.findFirst({
    where: {
      id: leaveId,
      OR: [
        { approverId:          req.user.id, status: "pending"           },
        { secondaryApproverId: req.user.id, status: "pending_secondary" },
      ],
    },
  });

  if (!leave)
    return res.status(404).json({ message: "Leave request not found or already processed." });

  const isSecondaryRejecting = leave.status === "pending_secondary";

  const data = await prisma.leave.update({
    where: { id: leaveId },
    data: isSecondaryRejecting
      ? { status: "rejected", secondaryApproverComments: approverComments }
      : { status: "rejected", approverComments },
  });

  try {
    const leaveUser = await prisma.user.findUnique({
      where:  { id: leave.userId },
      select: { departmentId: true },
    });
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
    },
    orderBy: { startDate: "desc" },
  });

  const withNames = await _attachPolicyNames(leaves);
  const withHours = await _attachRequestedHours(withNames);
  const data = withHours.map((l) => {
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
    };
  });

  res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

const getPendingLeavesForApprover = async (req, res) => {
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  // All management roles: company-wide pending leaves (view-only for those not directed at them)
  const where = isManagement
    ? {
        User: { companyId: req.user.companyId },
        status: { in: ["pending", "pending_secondary"] },
      }
    : {
        OR: [
          { approverId:          req.user.id, status: "pending"           },
          { secondaryApproverId: req.user.id, status: "pending_secondary" },
        ],
      };

  const leaves = await prisma.leave.findMany({
    where,
    include: {
      User: {
        select: {
          id: true, email: true, username: true, role: true,
          profile: { select: { firstName: true, lastName: true } },
        },
      },
      approver: {
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
  const data = withHours.map((l) => {
    const raw = leaves.find((r) => r.id === l.id);
    const canAct =
      (raw.status === "pending"           && raw.approverId          === req.user.id) ||
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

  // All management roles: company-wide, all statuses (view-only unless directed at them)
  const where = isManagement
    ? {
        User: { companyId: req.user.companyId },
        ...(status ? { status: status.toLowerCase() } : {}),
      }
    : {
        OR: [
          { approverId:          req.user.id },
          { secondaryApproverId: req.user.id },
        ],
        ...(status ? { status: status.toLowerCase() } : {}),
      };

  const [leaves, total] = await Promise.all([
    prisma.leave.findMany({
      where,
      include: {
        User: {
          select: {
            id: true, email: true, username: true, role: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        approver: {
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
  const data = withHours.map((l) => {
    const raw = leaves.find((r) => r.id === l.id);
    const canAct =
      (raw.status === "pending"           && raw.approverId          === req.user.id) ||
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
    };
  });

  res.json({ data, pagination: { total, limit, offset, hasMore: offset + limit < total } });
};

// ─────────────────────────────────────────────────────────────────────────────

const getApprovers = async (req, res) => {
  const approvers = await prisma.user.findMany({
    where: {
      companyId: req.user.companyId,
      role:      { in: ["admin", "supervisor", "superadmin"] },
      NOT:       { id: req.user.id },
    },
    select: {
      id: true, email: true, username: true, role: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });
  const data = approvers.map((a) => ({
    ...a,
    name: a.profile
      ? `${a.profile.firstName || ""} ${a.profile.lastName || ""}`.trim()
      : a.username,
  }));
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
  const policies = await prisma.leavePolicy.findMany({
    where:   { companyId: req.user.companyId },
    include: { company: true, balances: { where: { userId: req.user.id } } },
  });
  const map = {};
  policies.forEach((p) => {
    const sum = p.balances.reduce((s, b) => s + Number(b.balanceHours), 0);
    map[p.leaveType] = {
      leaveType:    p.leaveType,
      balanceHours: sum,
      shiftHours:   Number(p.company.defaultShiftHours || 8),
    };
  });
  res.json({ data: Object.values(map) });
};

// ─────────────────────────────────────────────────────────────────────────────

const getAffectedSchedules = async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate)
    return res.status(400).json({ message: "startDate and endDate are required." });

  if (new Date(startDate) > new Date(endDate))
    return res.status(400).json({ message: "startDate cannot be after endDate." });

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
    };
  });

  return res.json({ data });
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  submitLeaveRequest,
  getUserLeaves,
  getPendingLeavesForApprover,
  approveLeave,
  rejectLeave,
  getApprovers,
  deleteLeave,
  getLeavesForApprover,
  getBalance,
  listBalances,
  getAffectedSchedules,
};
