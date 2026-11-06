// src/utils/systemAgent.js
//
// BB-110: B. Buddy — one hidden admin account per company (User.isSystemAgent)
// used by BizBuddy support staff. It works the Company panel only, never
// appears as a person (lists, counts, reports, payroll, notifications), and
// company admins can't touch it.

const { prisma } = require("@config/connection");
const ERROR_CODES = require("@constants/errorCodes");

// Spread into any prisma.user where clause that lists, counts or iterates people.
const HUMAN_ONLY = { isSystemAgent: false };

// Relation filter for models that point at a user, e.g. { user: HUMAN_USER }.
const HUMAN_USER = { is: HUMAN_ONLY };

// Route middleware: blocks employee-panel / self-service actions for B. Buddy.
// Must run after authenticate (needs req.user.isSystemAgent).
function blockSystemAgent(req, res, next) {
  if (req.user && req.user.isSystemAgent) {
    return res.status(403).json({
      message: "This action isn't available to the B. Buddy account.",
      code: ERROR_CODES.SYSTEM_AGENT_NOT_ALLOWED,
    });
  }
  next();
}

// True when the given user id is a B. Buddy account.
async function isSystemAgentUser(userId) {
  if (!userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isSystemAgent: true },
  });
  return Boolean(user && user.isSystemAgent);
}

// Sends the 403 for admin writes that target B. Buddy; returns true when it did.
// Usage: if (await rejectIfSystemAgentTarget(res, id)) return;
async function rejectIfSystemAgentTarget(res, userId) {
  if (!(await isSystemAgentUser(userId))) return false;
  res.status(403).json({
    message: "The B. Buddy account is managed by BizBuddy and can't be changed here.",
    code: ERROR_CODES.SYSTEM_AGENT_PROTECTED,
  });
  return true;
}

// Route middleware factory: 403 when req.params[param] is a B. Buddy user id.
// For admin writes on another user (edit, delete, payroll details, ...).
function protectSystemAgentTarget(param = "id") {
  return async (req, res, next) => {
    if (await rejectIfSystemAgentTarget(res, req.params[param])) return;
    next();
  };
}

// Can this support agent enter this company as B. Buddy right now?
// Returns { ok: true, agent } or { ok: false, reason: "invalid" | "not_assigned" }.
// "invalid" = unknown, inactive or archived (removed) agent.
async function checkAgentAccess(agentId, companyId) {
  if (!agentId) return { ok: false, reason: "invalid" };
  const agent = await prisma.supportAgent.findUnique({
    where: { id: agentId },
    select: { id: true, active: true, archivedAt: true, companyId: true },
  });
  if (!agent || !agent.active || agent.archivedAt) return { ok: false, reason: "invalid" };
  // One company per staff member — it must be the company being entered
  if (!agent.companyId || agent.companyId !== companyId) return { ok: false, reason: "not_assigned" };
  return { ok: true, agent };
}

module.exports = {
  HUMAN_ONLY,
  HUMAN_USER,
  blockSystemAgent,
  isSystemAgentUser,
  rejectIfSystemAgentTarget,
  protectSystemAgentTarget,
  checkAgentAccess,
};
