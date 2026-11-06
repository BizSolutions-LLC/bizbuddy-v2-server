// src/controllers/Features/leaveBalanceController.js
const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { leaveVisibilityWhere } = require("@utils/leaveUtils");
const {
  loadCreditCompany,
  isTracked,
  addToLots,
  consumeFromLots,
  fyLabel,
  dateColStr,
} = require("@services/Leave/leaveCreditService");

const adjustBalance = async (req, res) => {
  const { targetUserId, leaveTypes, hours, note } = req.body;
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
  if (!note || !note.trim())
    return res
      .status(400)
      .json({ message: "A reason is required for a manual balance adjustment." });

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

  // BB-098: once leave credits are set up, a manual credit lands in the
  // current fiscal year's lot and a manual debit drains the oldest lots first.
  const creditCompany = await loadCreditCompany(prisma, req.user.companyId);
  const tracked = isTracked(creditCompany);

  const out = [];
  for (const pol of policies) {
    const bal = await prisma.$transaction(async (tx) => {
      const existing = await tx.leaveBalance.findUnique({
        where: { userId_policyId: { userId: targetUserId, policyId: pol.id } },
      });
      const balanceBefore = existing ? Number(existing.balanceHours) : 0;
      // Floor at 0 for negative adjustments — applied to the actual stored
      // balance now, not just the ledger record, so the two can never disagree
      // (previously the upsert used a raw `increment`, which could push the
      // real balance negative while the ledger claimed it floored at 0).
      const balanceAfter = hours > 0 ? balanceBefore + hours : Math.max(0, balanceBefore + hours);

      const updated = await tx.leaveBalance.upsert({
        where: { userId_policyId: { userId: targetUserId, policyId: pol.id } },
        update: { balanceHours: balanceAfter },
        create: {
          userId:       targetUserId,
          policyId:     pol.id,
          balanceHours: balanceAfter,
        },
      });

      if (tracked) {
        if (hours > 0) {
          await addToLots(tx, creditCompany, { userId: targetUserId, policyId: pol.id, hours, balanceBefore });
        } else if (balanceBefore > balanceAfter) {
          await consumeFromLots(tx, { userId: targetUserId, policyId: pol.id, hours: balanceBefore - balanceAfter });
        }
      }

      await tx.leaveTransaction.create({
        data: {
          userId:        targetUserId,
          policyId:      pol.id,
          type:          "adjustment",
          hours,
          balanceBefore,
          balanceAfter:  Number(updated.balanceHours),
          performedById: req.user.id,
          note:          note.trim(),
        },
      });
      return updated;
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
    where: { ...HUMAN_ONLY, companyId, status: "active" },
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
  const policyIds = policies.map((p) => p.id);

  const company = await loadCreditCompany(prisma, companyId);
  const tracked = isTracked(company);

  const [balances, deductionTotals, expiredTotals, creditLots] = await Promise.all([
    prisma.leaveBalance.findMany({
      where:  { policyId: { in: policyIds } },
      select: { userId: true, policyId: true, balanceHours: true },
    }),
    prisma.leaveTransaction.groupBy({
      by:    ["userId", "policyId"],
      where: { policyId: { in: policyIds }, type: "deduction" },
      _sum:  { hours: true },
    }),
    prisma.leaveTransaction.groupBy({
      by:    ["userId", "policyId"],
      where: { policyId: { in: policyIds }, type: "expired" },
      _sum:  { hours: true },
    }),
    // BB-098: fiscal-year lots, oldest first. Fully used lots (0h) are kept so
    // the year still shows; expired lots are dropped once they're back to 0 —
    // one that a cancelled leave refilled stays until the worker re-expires it.
    tracked
      ? prisma.leaveCredit.findMany({
          where: {
            policyId: { in: policyIds },
            OR: [{ remainingHours: { gt: 0 } }, { expiredAt: null }],
          },
          orderBy: { fiscalYear: "asc" },
          select:  { userId: true, policyId: true, fiscalYear: true, remainingHours: true, expiresOn: true },
        })
      : [],
  ]);

  const lotMap = {};
  creditLots.forEach((l) => {
    if (!lotMap[l.userId]) lotMap[l.userId] = {};
    (lotMap[l.userId][l.policyId] ??= []).push({
      fiscalYear:     l.fiscalYear,
      label:          fyLabel(company, l.fiscalYear),
      remainingHours: Number(l.remainingHours),
      expiresOn:      dateColStr(l.expiresOn),
    });
  });

  const availableMap = {};
  balances.forEach((b) => {
    if (!availableMap[b.userId]) availableMap[b.userId] = {};
    availableMap[b.userId][b.policyId] = Number(b.balanceHours);
  });

  const usedMap = {};
  deductionTotals.forEach((d) => {
    if (!usedMap[d.userId]) usedMap[d.userId] = {};
    usedMap[d.userId][d.policyId] = Math.abs(Number(d._sum.hours ?? 0));
  });

  const expiredMap = {};
  expiredTotals.forEach((d) => {
    if (!expiredMap[d.userId]) expiredMap[d.userId] = {};
    expiredMap[d.userId][d.policyId] = Math.abs(Number(d._sum.hours ?? 0));
  });

  // Same identity as listBalances: credits is derived (available + used +
  // expired), never independently summed, so it can't drift from the others.
  const rows = users.map((u) => {
    const fullName =
      `${u.profile?.firstName || ""} ${u.profile?.lastName || ""}`.trim() ||
      u.email;
    const balObj = {};
    policies.forEach((p) => {
      const available = availableMap[u.id]?.[p.id] ?? 0;
      const used       = usedMap[u.id]?.[p.id] ?? 0;
      const expired    = expiredMap[u.id]?.[p.id] ?? 0;
      balObj[p.leaveType] = {
        credits:    +(available + used + expired).toFixed(2),
        used,
        expired,
        available,
        creditLots: lotMap[u.id]?.[p.id] ?? [],
      };
    });
    return { userId: u.id, fullName, email: u.email, balances: balObj };
  });

  res.json({ data: rows, leaveTypes: policies.map((p) => p.leaveType) });
};

const getTransactions = async (req, res) => {
  const companyId = req.user.companyId;
  const isManagement = ["admin", "superadmin", "supervisor"].includes(req.user.role);

  const { userId, policyId, type, leaveId } = req.query;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let where;
  if (isManagement && userId) {
    // Drill-down into one specific employee (e.g. Balance Matrix cell click)
    const member = await prisma.user.findFirst({
      where: { id: userId, companyId },
    });
    if (!member) return res.status(404).json({ message: "User not found in this company" });
    where = { userId, policy: { companyId } };
  } else if (isManagement) {
    // No userId given — company/department-wide Leave Ledger feed, same
    // visibility rule as everywhere else in this module (admins/superadmins
    // company-wide, supervisors scoped to their own department).
    const actingUser = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { departmentId: true },
    });
    where = {
      ...leaveVisibilityWhere(companyId, req.user.role, req.user.id, actingUser?.departmentId, "user"),
      policy: { companyId },
    };
  } else {
    // Employees only ever see their own transactions
    where = { userId: req.user.id, policy: { companyId } };
  }

  if (policyId) where.policyId = policyId;
  if (type)     where.type     = type;
  if (leaveId)  where.leaveId  = leaveId;

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
        // Only meaningfully distinct from performedBy on a multi-employee feed
        // (company/department-wide, no userId filter) — for a single-employee
        // drill-down it's always the same person on every row.
        user: {
          select: {
            id: true, email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
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

  const _formatPerson = (u) =>
    u
      ? {
          id:   u.id,
          name: u.profile
            ? `${u.profile.firstName || ""} ${u.profile.lastName || ""}`.trim()
            : u.email,
        }
      : null;

  // BB-116: a ledger row is dated when the action happened (e.g. approval), which
  // says nothing about which days the leave covers. Attach the leave's own dates
  // and approver. LeaveTransaction.leaveId has no Prisma relation, so batch-load.
  const leaveIds = [...new Set(transactions.map((t) => t.leaveId).filter(Boolean))];
  const personSelect = { id: true, email: true, profile: { select: { firstName: true, lastName: true } } };
  const [leaves, company] = await Promise.all([
    leaveIds.length
      ? prisma.leave.findMany({
          where:  { id: { in: leaveIds } },
          select: {
            id: true, startDate: true, endDate: true, status: true,
            approver:  { select: personSelect },
            decidedBy: { select: personSelect },
          },
        })
      : [],
    prisma.company.findUnique({ where: { id: companyId }, select: { timeZone: true } }),
  ]);
  const companyTz = company?.timeZone || "America/Los_Angeles";
  const leaveMap = new Map(
    leaves.map((l) => [
      l.id,
      {
        id:        l.id,
        startDate: moment.tz(l.startDate, companyTz).format("YYYY-MM-DD"),
        endDate:   moment.tz(l.endDate,   companyTz).format("YYYY-MM-DD"),
        status:    l.status,
        approver:  _formatPerson(l.approver),
        decidedBy: _formatPerson(l.decidedBy),
      },
    ])
  );

  const data = transactions.map((t) => ({
    ...t,
    hours:         t.hours         != null ? Number(t.hours)         : null,
    balanceBefore: t.balanceBefore != null ? Number(t.balanceBefore) : null,
    balanceAfter:  t.balanceAfter  != null ? Number(t.balanceAfter)  : null,
    user:        _formatPerson(t.user),
    performedBy: _formatPerson(t.performedBy),
    leave:       t.leaveId ? (leaveMap.get(t.leaveId) ?? null) : null,
  }));

  res.json({ data, pagination: { total, limit, offset, hasMore: offset + limit < total } });
};

module.exports = { adjustBalance, listMatrix, getTransactions };
