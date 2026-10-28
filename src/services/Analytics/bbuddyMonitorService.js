// src/services/Analytics/bbuddyMonitorService.js
//
// BB-110: system-admin monitoring of everything done through B. Buddy
// accounts. Built on RequestLog — every request made with a B. Buddy token is
// tagged isSystemAgent + agentId (the support staff member behind it) by
// requestLogger, including sign-ins and failed PIN attempts.

const bcrypt = require("bcryptjs");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { BBUDDY_EMAIL, BBUDDY_PASSWORD_HASH } = require("@config/env");
const { buildSystemAgentData } = require("@services/systemAgentService");

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

// Readable labels for the actions worth policing, keyed by "METHOD endpoint"
// as requestLogger normalizes it (every id segment becomes :id). Anything not
// listed falls back to the raw method + endpoint.
const ACTION_LABELS = {
  "POST /api/account/login": "Signed in",
  "POST /api/account/sign-in": "Signed in",
  "GET /api/account/sign-in": "Signed in",

  // Cutoff approvals
  "POST /api/cutoff-periods/create": "Created cutoff period",
  "POST /api/cutoff-periods/:id/sync": "Synced cutoff period",
  "PATCH /api/cutoff-periods/:id/approvals/:id": "Approved / edited / rejected time log",
  "PATCH /api/cutoff-periods/:id/approvals/bulk": "Bulk approval of time logs",
  "PATCH /api/cutoff-periods/:id/approvals/:id/set-punch-type": "Changed punch type",
  "PATCH /api/cutoff-periods/:id/approvals/:id/reset": "Reset time log approval",
  "PATCH /api/cutoff-periods/:id/approvals/:id/conflict": "Resolved leave conflict",
  "PATCH /api/cutoff-periods/:id/ot-blocks/:id": "Approved / rejected OT block",
  "PATCH /api/cutoff-periods/:id/fixed-hours/:id": "Edited fixed hours",
  "PATCH /api/cutoff-periods/:id/status": "Changed cutoff period status",
  "POST /api/cutoff-periods/:id/finalize": "Finalized cutoff period",
  "DELETE /api/cutoff-periods/:id": "Deleted cutoff period",

  // Time logs
  "PATCH /api/timelogs/:id/datetime": "Edited time log time",
  "PATCH /api/timelogs/:id/punch-type": "Edited time log punch type",
  "PUT /api/timelogs/:id/lunch-break": "Edited lunch break",
  "DELETE /api/timelogs/:id/lunch-break": "Removed lunch break",
  "DELETE /api/timelogs/:id/auto-breaks": "Cleared auto breaks",
  "DELETE /api/timelogs/:id": "Deleted time log",

  // Requests
  "PUT /api/leaves/:id/approve": "Approved leave",
  "PUT /api/leaves/:id/reject": "Rejected leave",
  "PUT /api/leaves/:id/cancel": "Cancelled leave",
  "DELETE /api/leaves/:id": "Deleted leave",
  "PUT /api/overtime/:id/approve": "Approved overtime",
  "PUT /api/overtime/:id/reject": "Rejected overtime",
  "DELETE /api/overtime/:id": "Deleted overtime",
  "PATCH /api/request-punch-log/approve/:id": "Approved punch request",
  "PATCH /api/request-punch-log/reject/:id": "Rejected punch request",
  "PATCH /api/contest-policy/approve/:id": "Approved contest",
  "PATCH /api/contest-policy/reject/:id": "Rejected contest",

  // People
  "POST /api/employee": "Created employee",
  "POST /api/employee/bulk": "Bulk-created employees",
  "PUT /api/employee/:id": "Edited employee",
  "DELETE /api/employee/:id": "Deleted employee",
  "PUT /api/employment-details/:id": "Edited employment details",
  "PUT /api/employee-payroll-details/employees/:id/payroll-details": "Edited payroll details",
  "DELETE /api/employee-payroll-details/employees/:id/payroll-details": "Reset payroll details",

  // Payroll / money
  "POST /api/payroll-system/save-payroll-run": "Saved payroll run",
  "POST /api/disbursements/from-payroll-run/:id": "Created disbursement batch",
  "POST /api/disbursements/:id/approve": "Approved disbursement batch",
  "POST /api/disbursements/:id/submit": "Submitted disbursement batch",
  "POST /api/disbursements/:id/cancel": "Cancelled disbursement batch",

  // Company
  "PUT /api/company/me": "Edited company profile",
  "PATCH /api/company-settings": "Edited company settings",
  "PUT /api/company-settings/notification-settings": "Edited notification settings",
  "POST /api/shiftschedules/create": "Created shift schedule",
  "PUT /api/shiftschedules/:id": "Edited shift schedule",
  "DELETE /api/shiftschedules/:id": "Deleted shift schedule",
};

function actionLabel(method, endpoint) {
  const key = `${method} ${(endpoint || "").replace(/\/$/, "")}`;
  return ACTION_LABELS[key] || null;
}

function dateRange({ startDate, endDate }, defaultDays = 7) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate
    ? new Date(startDate)
    : new Date(end.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  return { gte: start, lte: end };
}

async function listActivity(filters = {}, page = 1, limit = 50) {
  const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const where = {
    isSystemAgent: true,
    createdAt: dateRange(filters, 30),
    ...(filters.companyId ? { companyId: filters.companyId } : {}),
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(filters.method ? { method: String(filters.method).toUpperCase() } : {}),
    ...(filters.writesOnly === "true" && !filters.method ? { method: { in: WRITE_METHODS } } : {}),
    ...(filters.endpoint ? { endpoint: { contains: filters.endpoint } } : {}),
    ...(filters.failedOnly === "true" ? { isFailed: true } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        createdAt: true,
        method: true,
        url: true,
        endpoint: true,
        statusCode: true,
        isFailed: true,
        responseTime: true,
        requestBody: true,
        queryParams: true,
        ipAddress: true,
        userAgent: true,
        errorMessage: true,
        userId: true,
        company: { select: { id: true, name: true } },
        agent: { select: { id: true, code: true, name: true } },
      },
    }),
    prisma.requestLog.count({ where }),
  ]);

  return {
    logs: rows.map((r) => ({
      ...r,
      isWrite: WRITE_METHODS.includes(r.method),
      action: actionLabel(r.method, r.endpoint) || `${r.method} ${r.endpoint}`,
    })),
    pagination: {
      total,
      page: skip / take + 1,
      limit: take,
      totalPages: Math.ceil(total / take),
    },
  };
}

async function getSummary(filters = {}) {
  const createdAt = dateRange(filters, 7);
  const base = { isSystemAgent: true, createdAt };

  const [byCompany, byAgent, failedLogins] = await Promise.all([
    prisma.requestLog.groupBy({
      by: ["companyId", "method"],
      where: base,
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.requestLog.groupBy({
      by: ["agentId", "method"],
      where: base,
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.requestLog.count({
      where: { ...base, endpoint: { in: ["/api/account/login", "/api/account/sign-in"] }, isFailed: true },
    }),
  ]);

  const fold = (groups, key) => {
    const out = new Map();
    for (const g of groups) {
      const id = g[key] || null;
      const row = out.get(id) || { id, total: 0, writes: 0, reads: 0, lastActivityAt: null };
      row.total += g._count._all;
      if (WRITE_METHODS.includes(g.method)) row.writes += g._count._all;
      else row.reads += g._count._all;
      if (!row.lastActivityAt || g._max.createdAt > row.lastActivityAt) row.lastActivityAt = g._max.createdAt;
      out.set(id, row);
    }
    return [...out.values()].sort((a, b) => b.total - a.total);
  };

  const companies = fold(byCompany, "companyId");
  const agents = fold(byAgent, "agentId");

  const [companyRows, agentRows] = await Promise.all([
    prisma.company.findMany({
      where: { id: { in: companies.map((c) => c.id).filter(Boolean) } },
      select: { id: true, name: true },
    }),
    prisma.supportAgent.findMany({
      where: { id: { in: agents.map((a) => a.id).filter(Boolean) } },
      select: { id: true, code: true, name: true },
    }),
  ]);
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  const agentInfo = new Map(agentRows.map((a) => [a.id, a]));

  return {
    range: { startDate: createdAt.gte, endDate: createdAt.lte },
    totals: {
      requests: companies.reduce((n, c) => n + c.total, 0),
      writes: companies.reduce((n, c) => n + c.writes, 0),
      failedLogins,
    },
    byCompany: companies.map((c) => ({ ...c, companyName: companyName.get(c.id) || null })),
    // id null = requests with no identified staff (failed sign-ins before the PIN check)
    byAgent: agents.map((a) => ({ ...a, code: agentInfo.get(a.id)?.code || null, name: agentInfo.get(a.id)?.name || null })),
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Every company with its B. Buddy account (or the lack of one) and the support
// staff assigned to it. BB-107: a company with no active people (B. Buddy aside)
// is retired — listed last, for the dashboard to grey out.
async function listAccounts() {
  const companies = await prisma.company.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      User: {
        where: { isSystemAgent: true },
        select: { id: true, email: true, status: true, lastLoginAt: true, createdAt: true },
      },
      supportAgents: {
        where: { archivedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true, active: true },
      },
      _count: { select: { User: { where: { ...HUMAN_ONLY, status: "active" } } } },
    },
  });
  return companies
    .map((c) => ({
      companyId: c.id,
      companyName: c.name,
      activeUsers: c._count.User,
      isRetired: c._count.User === 0,
      hasBBuddy: c.User.length > 0,
      account: c.User[0] || null,
      assignedAgents: c.supportAgents,
    }))
    .sort((a, b) => Number(a.isRetired) - Number(b.isRetired)); // stable: name order kept within each group
}

// BB-107: "Set up B. Buddy" from the Companies table — replaces running
// scripts/bb110-create-bbuddy-accounts.js per company.
async function setupAccount(companyId) {
  if (!BBUDDY_EMAIL || !BBUDDY_PASSWORD_HASH)
    throw httpError(400, "B. Buddy isn't configured on this server (BBUDDY_EMAIL / BBUDDY_PASSWORD_HASH).");

  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!company) throw httpError(404, "Company not found.");

  const existing = await prisma.user.findFirst({
    where: { companyId, isSystemAgent: true },
    select: { status: true },
  });
  if (existing) throw httpError(409, `${company.name} already has B. Buddy (${existing.status}).`);

  const email = BBUDDY_EMAIL.trim().toLowerCase();
  const taken = await prisma.user.findFirst({ where: { companyId, email }, select: { id: true } });
  if (taken) throw httpError(409, `A person in ${company.name} already uses ${email}, so B. Buddy can't be added.`);

  return prisma.user.create({
    data: buildSystemAgentData(companyId, { email, passwordHash: BBUDDY_PASSWORD_HASH }),
    select: { id: true, email: true, status: true, lastLoginAt: true, createdAt: true },
  });
}

const AGENT_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  archivedAt: true,
  pinLockedUntil: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { id: true, name: true } },
};

// `companies` (0 or 1 entries) kept so dashboard screens built for the earlier
// multi-company shape keep rendering.
function shapeAgent(a) {
  return a && { ...a, companies: a.company ? [a.company] : [] };
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function validatePin(pin) {
  if (!/^\d{6,8}$/.test(String(pin || ""))) throw httpError(400, "PIN must be 6–8 digits.");
}

function parseBool(v) {
  return v === true || v === "true";
}

// One company per staff member. Accepts { companyId } or the earlier
// { companyIds: [] | [id] }. Returns undefined (not sent), null (unassign) or an id.
async function resolveCompanyId({ companyId, companyIds, allCompanies }) {
  if (parseBool(allCompanies)) {
    throw httpError(400, "Each staff member can be assigned to one company only.");
  }
  let id = companyId;
  if (id === undefined && companyIds !== undefined) {
    if (!Array.isArray(companyIds)) throw httpError(400, "companyIds must be an array.");
    const ids = [...new Set(companyIds.map(String))];
    if (ids.length > 1) throw httpError(400, "Each staff member can be assigned to one company only.");
    id = ids[0] ?? null;
  }
  if (id === undefined || id === null || id === "") return id === undefined ? undefined : null;
  const company = await prisma.company.findUnique({ where: { id: String(id) }, select: { id: true } });
  if (!company) throw httpError(400, `Unknown company id: ${id}`);
  return company.id;
}

// Archived ("removed") agents are hidden unless includeArchived.
async function listAgents({ includeArchived } = {}) {
  const agents = await prisma.supportAgent.findMany({
    where: parseBool(includeArchived) ? {} : { archivedAt: null },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: AGENT_SELECT,
  });
  return agents.map(shapeAgent);
}

// Body: { code, name, pin, companyId? }
async function createAgent({ code, name, pin, ...assignment }) {
  const cleanCode = normalizeCode(code);
  if (!/^[A-Z0-9-]{2,20}$/.test(cleanCode) || !name || !String(name).trim()) {
    throw httpError(400, "code (2–20 letters, digits or dashes) and name are required.");
  }
  validatePin(pin);
  const companyId = await resolveCompanyId(assignment);
  // Codes stay reserved after an agent is removed, so old trail entries never get a new owner.
  const exists = await prisma.supportAgent.findUnique({ where: { code: cleanCode } });
  if (exists) throw httpError(409, `Staff code ${cleanCode} is already taken${exists.archivedAt ? " (by a removed agent)" : ""}.`);

  const agent = await prisma.supportAgent.create({
    data: {
      code: cleanCode,
      name: String(name).trim(),
      pinHash: await bcrypt.hash(String(pin), 10),
      companyId: companyId || null,
    },
    select: AGENT_SELECT,
  });
  return shapeAgent(agent);
}

// Body (all optional): { name, pin, active, companyId }
// companyId re-assigns (null = unassign). Moving a staff member ends their
// session in the old company on their next request.
async function updateAgent(id, { name, pin, active, ...assignment }) {
  const existing = await prisma.supportAgent.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
  if (!existing) throw httpError(404, "Support agent not found.");
  if (existing.archivedAt) throw httpError(409, "This support agent was removed and can't be changed.");

  const data = {};
  if (name !== undefined) {
    if (!String(name).trim()) throw httpError(400, "name can't be empty.");
    data.name = String(name).trim();
  }
  if (pin !== undefined) {
    validatePin(pin);
    data.pinHash = await bcrypt.hash(String(pin), 10);
    // A PIN reset also clears any lockout
    data.failedPinAttempts = 0;
    data.pinLockedUntil = null;
  }
  if (active !== undefined) data.active = parseBool(active);
  const companyId = await resolveCompanyId(assignment);
  if (companyId !== undefined) data.companyId = companyId;

  const agent = await prisma.supportAgent.update({ where: { id }, data, select: AGENT_SELECT });
  return shapeAgent(agent);
}

// "Remove" from the dashboard: archived, never hard-deleted, so the activity
// trail keeps their name. They can't sign in again and are signed out now.
async function archiveAgent(id) {
  const existing = await prisma.supportAgent.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
  if (!existing) throw httpError(404, "Support agent not found.");
  if (existing.archivedAt) throw httpError(409, "This support agent was already removed.");
  const agent = await prisma.supportAgent.update({
    where: { id },
    data: { archivedAt: new Date(), active: false },
    select: AGENT_SELECT,
  });
  return shapeAgent(agent);
}

module.exports = {
  ACTION_LABELS,
  actionLabel,
  listActivity,
  getSummary,
  listAccounts,
  setupAccount,
  listAgents,
  createAgent,
  updateAgent,
  archiveAgent,
};
