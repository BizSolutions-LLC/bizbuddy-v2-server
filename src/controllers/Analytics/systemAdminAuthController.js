// src/controllers/Analytics/systemAdminAuthController.js
//
// BB-110: two-step system-admin sign-in with mandatory authenticator-app 2FA.
// See services/Analytics/systemAdminAccountService.js for the flow.

const accounts = require("@services/Analytics/systemAdminAccountService");
const { readToken } = require("@middlewares/systemAdminAuth");

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
};
const SESSION_MAX_AGE = 60 * 60 * 8 * 1000; // 8 hours, matches the token

// Service errors carry status / code / lockedUntil; the global handler would drop those.
function sendError(res, error, next) {
  if (!error.status) return next(error);
  return res.status(error.status).json({
    success: false,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.lockedUntil ? { lockedUntil: error.lockedUntil } : {}),
  });
}

function startSession(res, { token, admin, ...rest }) {
  res.cookie("system-admin-token", token, { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE });
  return res.status(200).json({ success: true, message: "Login successful", token, admin, ...rest });
}

/**
 * POST /api/system-admin/auth/login
 * Body: { username, password }
 * → { mfaRequired: true, mfaToken }                                   (2FA set up)
 * → { mfaSetupRequired: true, mfaToken, secret, otpauthUrl }          (first sign-in)
 */
const login = async (req, res, next) => {
  try {
    const result = await accounts.passwordStep(req.body || {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, next);
  }
};

/**
 * POST /api/system-admin/auth/2fa/setup
 * Body: { mfaToken, code } — first code from the newly scanned authenticator.
 * → session + { recoveryCodes: [10 codes] } (shown once)
 */
const confirmSetup = async (req, res, next) => {
  try {
    return startSession(res, await accounts.confirmSetup(req.body || {}));
  } catch (error) {
    return sendError(res, error, next);
  }
};

/**
 * POST /api/system-admin/auth/2fa/verify
 * Body: { mfaToken, code } or { mfaToken, recoveryCode }
 * → session + { recoveryCodesRemaining }
 */
const verifyMfa = async (req, res, next) => {
  try {
    return startSession(res, await accounts.verifyStep(req.body || {}));
  } catch (error) {
    return sendError(res, error, next);
  }
};

/**
 * POST /api/system-admin/auth/logout
 * Ends every session of this admin (all browsers), then clears the cookie.
 */
const logout = async (req, res, next) => {
  try {
    const admin = await accounts.adminFromSession(readToken(req));
    if (admin) await accounts.logout(admin.id);
    res.clearCookie("system-admin-token", COOKIE_OPTIONS);
    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("System admin logout error:", error);
    next(error);
  }
};

/**
 * GET /api/system-admin/auth/verify
 * → { success, user: { id, username, name, isOwner, role, ... } } for a live session
 */
const verify = async (req, res, next) => {
  try {
    const admin = await accounts.adminFromSession(readToken(req));
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token",
      });
    }
    return res.status(200).json({
      success: true,
      user: { ...accounts.publicAdmin(admin), role: "system-admin" },
    });
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

/**
 * PUT /api/system-admin/auth/password   (signed in)
 * Body: { currentPassword, newPassword } — ends every session; sign in again.
 */
const changePassword = async (req, res, next) => {
  try {
    await accounts.changeOwnPassword(req.systemAdmin.id, req.body || {});
    res.clearCookie("system-admin-token", COOKIE_OPTIONS);
    return res.status(200).json({ success: true, message: "Password changed. Please sign in again." });
  } catch (error) {
    return sendError(res, error, next);
  }
};

/**
 * POST /api/system-admin/auth/2fa/recovery-codes   (signed in)
 * Body: { code } — current authenticator code. Returns 10 new codes; old ones stop working.
 */
const regenerateRecoveryCodes = async (req, res, next) => {
  try {
    const result = await accounts.regenerateRecoveryCodes(req.systemAdmin.id, req.body || {});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, next);
  }
};

module.exports = {
  login,
  confirmSetup,
  verifyMfa,
  logout,
  verify,
  changePassword,
  regenerateRecoveryCodes,
  sendError,
};
