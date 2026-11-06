// src/middlewares/authMiddleware.js

const jwt = require("jsonwebtoken");
const { prisma } = require("@config/connection");
const { JWT_SECRET } = require("@config/env");
const { checkAgentAccess } = require("@utils/systemAgent");

async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Access token missing." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });

    if (!user) {
      return res.status(401).json({ message: "User not found." });
    }

    // Reject tokens issued before sign-out, logout-all, or token invalidation
    if (user.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({
        message: "Session ended. Please sign in again.",
        code: "TOKEN_VERSION_MISMATCH",
      });
    }

    // BB-107: an inactive or deleted account is signed out on its next request,
    // whatever token it holds. Same code as above so web and mobile sign out.
    if (user.status !== "active") {
      return res.status(401).json({
        message: "Your account is inactive. Please contact your administrator.",
        code: "TOKEN_VERSION_MISMATCH",
      });
    }

    // BB-110: a B. Buddy token must carry a support agent who is still active and
    // still assigned to this company — deactivating, removing or unassigning a
    // staff member ends their sessions immediately (tokens don't expire).
    if (user.isSystemAgent) {
      const access = await checkAgentAccess(decoded.agentId, user.companyId);
      if (!access.ok) {
        return res.status(401).json({
          message: "Session ended. Please sign in again.",
          code: "TOKEN_VERSION_MISMATCH",
        });
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      // BB-110: B. Buddy account + the support staff member behind it
      isSystemAgent: user.isSystemAgent,
      agentId: user.isSystemAgent ? decoded.agentId : null,
    };

    next();
  } catch (error) {
    console.error("Authentication Error:", error);
    return res.status(403).json({ message: "Invalid or expired token." });
  }
}

module.exports = authenticateToken;