// src/controllers/Analytics/bbuddyMonitorController.js
//
// BB-110: system-admin endpoints for policing B. Buddy activity and managing
// the support staff who sign in through it.

const monitorService = require("@services/Analytics/bbuddyMonitorService");

/**
 * GET /api/system-admin/bbuddy/activity
 * Query: companyId, agentId, startDate, endDate (default last 30 days), method,
 *        writesOnly=true, endpoint, failedOnly=true, page, limit (max 200)
 */
async function getActivity(req, res, next) {
  try {
    const { page = 1, limit = 50, ...filters } = req.query;
    const result = await monitorService.listActivity(filters, page, limit);
    res.status(200).json({ success: true, data: result.logs, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/system-admin/bbuddy/summary
 * Query: startDate, endDate (default last 7 days)
 */
async function getSummary(req, res, next) {
  try {
    const data = await monitorService.getSummary(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/system-admin/bbuddy/accounts
 * Every company, its B. Buddy account (hasBBuddy=false where missing), and the
 * support staff assigned to it (assignedAgents).
 */
async function getAccounts(req, res, next) {
  try {
    const data = await monitorService.listAccounts();
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/system-admin/bbuddy/accounts/:companyId
 * BB-107: creates the company's B. Buddy ("Set up B. Buddy"). 409 if it already has one.
 */
async function setupAccount(req, res, next) {
  try {
    const data = await monitorService.setupAccount(req.params.companyId);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/** GET /api/system-admin/bbuddy/agents  Query: includeArchived=true to also list removed staff */
async function getAgents(req, res, next) {
  try {
    const data = await monitorService.listAgents(req.query);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/** POST /api/system-admin/bbuddy/agents  Body: { code, name, pin, companyId? } — one company per staff member */
async function createAgent(req, res, next) {
  try {
    const data = await monitorService.createAgent(req.body || {});
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/system-admin/bbuddy/agents/:id
 * Body (all optional): { name, pin, active, companyId }
 * companyId re-assigns to a different company (null = unassign).
 */
async function updateAgent(req, res, next) {
  try {
    const data = await monitorService.updateAgent(req.params.id, req.body || {});
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/system-admin/bbuddy/agents/:id  Remove = archive (trail kept, can't sign in again) */
async function removeAgent(req, res, next) {
  try {
    const data = await monitorService.archiveAgent(req.params.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getActivity,
  getSummary,
  getAccounts,
  setupAccount,
  getAgents,
  createAgent,
  updateAgent,
  removeAgent,
};
