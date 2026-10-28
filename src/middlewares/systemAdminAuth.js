// src/middlewares/systemAdminAuth.js
//
// BB-110: verifies an individual system-admin session (cookie or Bearer).
// The admin must still exist, be active, have 2FA enabled, and the token's
// version must match (logout / password change / 2FA reset / deactivation
// end every session immediately).

const { adminFromSession } = require("@services/Analytics/systemAdminAccountService");

function readToken(req) {
  return (req.cookies && req.cookies["system-admin-token"]) || req.headers.authorization?.replace("Bearer ", "");
}

const verifySystemAdmin = async (req, res, next) => {
  try {
    // No fallback secret: without one anyone could sign their own token.
    if (!process.env.SYSTEM_ADMIN_JWT_SECRET) {
      console.error("System admin auth: SYSTEM_ADMIN_JWT_SECRET is not set — rejecting.");
      return res.status(503).json({
        success: false,
        message: "System admin access is not configured.",
      });
    }

    const token = readToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token provided",
      });
    }

    const admin = await adminFromSession(token);
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Session ended. Please sign in again.",
      });
    }

    req.systemAdmin = {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      isOwner: admin.isOwner,
      role: "system-admin",
    };
    // Stamp the request log with who did it (same object requestLogger saves from)
    if (req.userContext) req.userContext.systemAdminId = admin.id;

    next();
  } catch (error) {
    console.error("System admin auth middleware error:", error);
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

// Owner-only routes (managing the other system admins). Runs after verifySystemAdmin.
const requireOwner = (req, res, next) => {
  if (!req.systemAdmin || !req.systemAdmin.isOwner) {
    return res.status(403).json({
      success: false,
      message: "Only an owner can manage system admins.",
    });
  }
  next();
};

module.exports = verifySystemAdmin;
module.exports.requireOwner = requireOwner;
module.exports.readToken = readToken;
