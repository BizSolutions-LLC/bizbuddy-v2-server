// src/controllers/Features/leaveBalanceController.js
const { prisma } = require("@config/connection");

const adjustBalance = async (req, res) => {
  const { targetUserId, leaveTypes, hours } = req.body;
  if (
    !targetUserId ||
    !Array.isArray(leaveTypes) ||
    !leaveTypes.length ||
    typeof hours !== "number" ||
    hours === 0
  )
    return res
      .status(400)
      .json({
        message: "targetUserId, leaveTypes[] and non-zero hours are required",
      });

  const employee = await prisma.user.findFirst({
    where: { id: targetUserId, companyId: req.user.companyId },
  });
  if (!employee)
    return res.status(404).json({ message: "User not found in this company" });

  const policies = await prisma.leavePolicy.findMany({
    where: { companyId: req.user.companyId, leaveType: { in: leaveTypes } },
    select: { id: true, leaveType: true },
  });
  if (policies.length !== leaveTypes.length)
    return res
      .status(404)
      .json({ message: "One or more leave types not found" });

  const out = [];
  for (const pol of policies) {
    const existing = await prisma.leaveBalance.findUnique({
      where: { userId_policyId: { userId: targetUserId, policyId: pol.id } },
    });
    const balanceBefore = existing ? Number(existing.balanceHours) : 0;
    const balanceAfter  = hours > 0 ? balanceBefore + hours : Math.max(0, balanceBefore + hours);

    const bal = await prisma.leaveBalance.upsert({
      where: { userId_policyId: { userId: targetUserId, policyId: pol.id } },
      update: { balanceHours: { increment: hours } },
      create: {
        userId:       targetUserId,
        policyId:     pol.id,
        balanceHours: hours > 0 ? hours : 0,
      },
    });

    await prisma.leaveTransaction.create({
      data: {
        userId:        targetUserId,
        policyId:      pol.id,
        type:          "adjustment",
        hours,
        balanceBefore,
        balanceAfter:  Number(bal.balanceHours),
        performedById: req.user.id,
      },
    });

    out.push({
      leaveType:    pol.leaveType,
      balanceHours: bal.balanceHours.toNumber(),
    });
  }
  res.json({ data: out });
};

const listMatrix = async (req, res) => {
  const companyId = req.user.companyId;

  const users = await prisma.user.findMany({
    where: { companyId, status: "active" },
    select: {
      id: true,
      email: true,
      profile: { select: { firstName: true, lastName: true } },
    },
    orderBy: { email: "asc" },
  });

  const policies = await prisma.leavePolicy.findMany({
    where: { companyId },
    select: { id: true, leaveType: true },
    orderBy: { leaveType: "asc" },
  });

  const balances = await prisma.leaveBalance.findMany({
    where: { policy: { companyId } },
    select: { userId: true, policyId: true, balanceHours: true },
  });

  const map = {};
  balances.forEach((b) => {
    if (!map[b.userId]) map[b.userId] = {};
    map[b.userId][b.policyId] = b.balanceHours.toNumber();
  });

  const rows = users.map((u) => {
    const fullName =
      `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() ||
      u.email;
    const balObj = {};
    policies.forEach((p) => {
      const hrs = map[u.id]?.[p.id] ?? 0;
      balObj[p.leaveType] = (balObj[p.leaveType] || 0) + hrs;
    });
    return { userId: u.id, fullName, email: u.email, balances: balObj };
  });

  res.json({ data: rows, leaveTypes: policies.map((p) => p.leaveType) });
};

const getTransactions = async (req, res) => {
  const companyId = req.user.companyId;
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  const { userId, policyId, type } = req.query;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  // Non-management can only see their own transactions
  const targetUserId = isManagement && userId ? userId : req.user.id;

  // Verify the target user belongs to this company
  if (isManagement && userId) {
    const member = await prisma.user.findFirst({
      where: { id: userId, companyId },
    });
    if (!member) return res.status(404).json({ message: "User not found in this company" });
  }

  const where = {
    userId: targetUserId,
    policy: { companyId },
    ...(policyId ? { policyId } : {}),
    ...(type     ? { type }     : {}),
  };

  const [transactions, total] = await Promise.all([
    prisma.leaveTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take:    limit,
      skip:    offset,
      select: {
        id:            true,
        type:          true,
        hours:         true,
        balanceBefore: true,
        balanceAfter:  true,
        leaveId:       true,
        note:          true,
        createdAt:     true,
        policy: { select: { id: true, leaveType: true } },
        performedBy: {
          select: {
            id: true, email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.leaveTransaction.count({ where }),
  ]);

  const data = transactions.map((t) => ({
    ...t,
    hours:         Number(t.hours),
    balanceBefore: Number(t.balanceBefore),
    balanceAfter:  Number(t.balanceAfter),
    performedBy: t.performedBy
      ? {
          id:   t.performedBy.id,
          name: t.performedBy.profile
            ? `${t.performedBy.profile.firstName || ""} ${t.performedBy.profile.lastName || ""}`.trim()
            : t.performedBy.email,
        }
      : null,
  }));

  res.json({ data, pagination: { total, limit, offset, hasMore: offset + limit < total } });
};

module.exports = { adjustBalance, listMatrix, getTransactions };
