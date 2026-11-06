// src/controllers/Analytics/systemAdminManagementController.js
//
// BB-110: owner-only management of system-admin accounts.

const accounts = require("@services/Analytics/systemAdminAccountService");
const { sendError } = require("@controllers/Analytics/systemAdminAuthController");

/** GET /api/system-admin/admins */
async function getAdmins(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await accounts.listAdmins() });
  } catch (error) {
    sendError(res, error, next);
  }
}

/**
 * POST /api/system-admin/admins
 * Body: { username, name, password, isOwner? } — password is temporary; they
 * set up their authenticator on first sign-in.
 */
async function createAdmin(req, res, next) {
  try {
    res.status(201).json({ success: true, data: await accounts.createAdmin(req.body || {}) });
  } catch (error) {
    sendError(res, error, next);
  }
}

/**
 * PUT /api/system-admin/admins/:id
 * Body (all optional): { name, active, isOwner } — deactivating signs them out.
 */
async function updateAdmin(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await accounts.updateAdmin(req.systemAdmin, req.params.id, req.body || {}) });
  } catch (error) {
    sendError(res, error, next);
  }
}

/** POST /api/system-admin/admins/:id/reset-2fa — lost phone; they re-enroll at next sign-in */
async function reset2fa(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await accounts.resetAdmin2fa(req.systemAdmin, req.params.id) });
  } catch (error) {
    sendError(res, error, next);
  }
}

/** POST /api/system-admin/admins/:id/reset-password  Body: { password } — also unlocks */
async function resetPassword(req, res, next) {
  try {
    res.status(200).json({
      success: true,
      data: await accounts.resetAdminPassword(req.systemAdmin, req.params.id, req.body || {}),
    });
  } catch (error) {
    sendError(res, error, next);
  }
}

module.exports = {
  getAdmins,
  createAdmin,
  updateAdmin,
  reset2fa,
  resetPassword,
};
