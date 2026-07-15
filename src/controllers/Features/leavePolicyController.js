// src/controllers/Features/leavePolicyController.js
const { prisma } = require("@config/connection");
const ERROR_CODES = require("@constants/errorCodes");

const _serializePolicy = (p) => ({
  id: p.id,
  leaveType: p.leaveType,
  annualAllocation: p.annualAllocation,
  accrualFrequency: p.accrualFrequency,
  accrualUnit: p.accrualUnit,
  carryOverAllowed: p.carryOverAllowed,
  carryOverLimit: p.carryOverLimit,
  negativeAllowed: p.negativeAllowed,
  isPaid: p.isPaid,
  isNotPaid: p.isNotPaid,
  assignedToAll: p.assignedToAll,
  assignedUserIds: p.assignments ? p.assignments.map((a) => a.userId) : undefined,
  isArchived: p.isArchived,
  archivedAt: p.archivedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

// Validates employeeIds belong to the caller's company; throws if any don't.
const _assertEmployeesInCompany = async (companyId, employeeIds) => {
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
  const found = await prisma.user.findMany({
    where: { id: { in: employeeIds }, companyId },
    select: { id: true },
  });
  if (found.length !== employeeIds.length) {
    const err = new Error("One or more employees do not belong to this company");
    err.status = 400;
    throw err;
  }
  return employeeIds;
};

const _replaceAssignments = async (tx, policyId, employeeIds) => {
  await tx.leavePolicyAssignment.deleteMany({ where: { policyId } });
  if (employeeIds.length > 0) {
    await tx.leavePolicyAssignment.createMany({
      data: employeeIds.map((userId) => ({ policyId, userId })),
      skipDuplicates: true,
    });
  }
};

const getPolicies = async (req, res) => {
  const includeArchived = req.query.includeArchived === "true";
  const data = await prisma.leavePolicy.findMany({
    where: {
      companyId: req.user.companyId,
      ...(includeArchived ? {} : { isArchived: false }),
    },
    include: { assignments: { select: { userId: true } } },
    orderBy: { leaveType: "asc" },
  });
  res.json({ data: data.map(_serializePolicy) });
};

const createPolicy = async (req, res) => {
  try {
    const { leaveType, isPaid = true, isNotPaid = true, assignedToAll = true, employeeIds } = req.body;

    if (!leaveType || !leaveType.trim()) {
      return res.status(400).json({ message: "leaveType is required" });
    }
    if (isPaid === false && isNotPaid === false) {
      return res.status(400).json({ message: "At least one of isPaid or isNotPaid must be enabled" });
    }

    const exists = await prisma.leavePolicy.findFirst({
      where: { companyId: req.user.companyId, leaveType },
    });
    if (exists)
      return res.status(409).json({ message: "Leave type already exists" });

    const employeeIdsToAssign = assignedToAll
      ? []
      : await _assertEmployeesInCompany(req.user.companyId, employeeIds);

    const data = await prisma.$transaction(async (tx) => {
      const policy = await tx.leavePolicy.create({
        data: {
          companyId: req.user.companyId,
          leaveType,
          annualAllocation: 0,
          accrualFrequency: "none",
          accrualUnit: "hours",
          isPaid,
          isNotPaid,
          assignedToAll,
        },
      });
      if (!assignedToAll) {
        await _replaceAssignments(tx, policy.id, employeeIdsToAssign);
      }
      return policy;
    });

    res.status(201).json({ data: _serializePolicy({ ...data, assignments: [] }) });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "Failed to create leave type" });
  }
};

const updatePolicy = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.leavePolicy.findFirst({
      where: { id, companyId: req.user.companyId },
    });
    if (!existing) return res.status(404).json({ message: "Leave type not found" });

    const leaveType = req.body.leaveType !== undefined ? req.body.leaveType : existing.leaveType;
    const isPaid = req.body.isPaid !== undefined ? req.body.isPaid : existing.isPaid;
    const isNotPaid = req.body.isNotPaid !== undefined ? req.body.isNotPaid : existing.isNotPaid;
    const assignedToAll = req.body.assignedToAll !== undefined ? req.body.assignedToAll : existing.assignedToAll;
    const isArchived = req.body.isArchived !== undefined ? Boolean(req.body.isArchived) : existing.isArchived;

    if (!leaveType || !leaveType.trim()) {
      return res.status(400).json({ message: "leaveType is required" });
    }
    if (isPaid === false && isNotPaid === false) {
      return res.status(400).json({ message: "At least one of isPaid or isNotPaid must be enabled" });
    }

    const employeeIdsToAssign = !assignedToAll && req.body.employeeIds !== undefined
      ? await _assertEmployeesInCompany(req.user.companyId, req.body.employeeIds)
      : null;

    // Only touch archivedAt on an actual state transition, not every save
    // while it's already archived/unarchived.
    const archivedAt = isArchived === existing.isArchived
      ? existing.archivedAt
      : (isArchived ? new Date() : null);

    const data = await prisma.$transaction(async (tx) => {
      const policy = await tx.leavePolicy.update({
        where: { id },
        data: { leaveType, isPaid, isNotPaid, assignedToAll, isArchived, archivedAt },
      });
      if (employeeIdsToAssign !== null) {
        await _replaceAssignments(tx, id, employeeIdsToAssign);
      }
      const assignments = await tx.leavePolicyAssignment.findMany({
        where: { policyId: id },
        select: { userId: true },
      });
      return { ...policy, assignments };
    });

    res.json({ data: _serializePolicy(data) });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "Failed to update leave type" });
  }
};

const deletePolicy = async (req, res) => {
  const { id } = req.params;

  const policy = await prisma.leavePolicy.findFirst({
    where: { id, companyId: req.user.companyId },
    select: { id: true },
  });
  if (!policy) return res.status(404).json({ message: "Leave type not found" });

  // Proactively check what's actually attached, rather than firing the
  // delete blind and parsing a generic P2003 — this is what lets the error
  // message name the real blockers instead of listing every possible cause.
  const [leaveCount, balanceCount, transactionCount, assignmentCount] = await Promise.all([
    prisma.leave.count({ where: { policyId: id } }),
    prisma.leaveBalance.count({ where: { policyId: id } }),
    prisma.leaveTransaction.count({ where: { policyId: id } }),
    prisma.leavePolicyAssignment.count({ where: { policyId: id } }),
  ]);

  const blockers = [];
  if (leaveCount > 0)       blockers.push(`${leaveCount} leave request${leaveCount === 1 ? "" : "s"}`);
  if (balanceCount > 0)     blockers.push(`${balanceCount} balance record${balanceCount === 1 ? "" : "s"}`);
  if (transactionCount > 0) blockers.push(`${transactionCount} ledger transaction${transactionCount === 1 ? "" : "s"}`);
  if (assignmentCount > 0)  blockers.push(`${assignmentCount} employee assignment${assignmentCount === 1 ? "" : "s"}`);

  if (blockers.length > 0) {
    return res.status(409).json({
      message: `Can't delete this leave type — it still has ${blockers.join(", ")} attached. Archive it instead to stop future use while keeping history intact.`,
      code: ERROR_CODES.LEAVE_POLICY_IN_USE,
    });
  }

  try {
    await prisma.leavePolicy.delete({ where: { id } });
    res.json({ message: "deleted" });
  } catch (error) {
    // Defensive fallback for a race — e.g. a leave request came in between
    // the count check above and this delete actually running.
    if (error.code === "P2003") {
      return res.status(409).json({
        message: "Can't delete this leave type — it now has dependent records attached. Archive it instead.",
        code: ERROR_CODES.LEAVE_POLICY_IN_USE,
      });
    }
    res.status(error.status || 500).json({ message: error.message || "Failed to delete leave type" });
  }
};

const getAvailablePolicies = async (req, res) => {
  try {
    const policies = await prisma.leavePolicy.findMany({
      where: {
        companyId: req.user.companyId,
        isArchived: false,
        OR: [
          { assignedToAll: true },
          { assignments: { some: { userId: req.user.id } } },
        ],
      },
      select: {
        id: true,
        leaveType: true,
        annualAllocation: true,
        accrualUnit: true,
        accrualFrequency: true,
        carryOverAllowed: true,
        carryOverLimit: true,
        negativeAllowed: true,
        isPaid: true,
        isNotPaid: true,
        createdAt: true,
        updatedAt: true,
        balances: {
          where: { userId: req.user.id },
          select: { balanceHours: true },
        },
      },
      orderBy: { leaveType: 'asc' },
    });

    const data = policies.map((p) => ({
      id:               p.id,
      leaveType:        p.leaveType,
      annualAllocation: p.annualAllocation,
      accrualUnit:      p.accrualUnit,
      accrualFrequency: p.accrualFrequency,
      carryOverAllowed: p.carryOverAllowed,
      carryOverLimit:   p.carryOverLimit,
      negativeAllowed:  p.negativeAllowed,
      isPaid:           p.isPaid,
      isNotPaid:        p.isNotPaid,
      createdAt:        p.createdAt,
      updatedAt:        p.updatedAt,
      balanceHours:     p.balances[0] ? Number(p.balances[0].balanceHours) : 0,
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching available policies:', error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch available leave policies",
      error: error.message
    });
  }
};

module.exports = { getPolicies, createPolicy, updatePolicy, deletePolicy, getAvailablePolicies };
