// src/middlewares/roleMiddleware.js

const { prisma } = require("@config/connection");

function authorizeRoles(...allowedRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        console.log("No user information found on request.");
        return res.status(403).json({ message: "Access denied: insufficient permissions." });
      }
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user) {
        console.log("User not found in database.");
        return res.status(403).json({ message: "Access denied: user not found." });
      }
      if (!allowedRoles.includes((user.role || "").toLowerCase())) {
        console.log("User does not have permission. User role:", user.role, "Allowed roles:", allowedRoles);
        return res.status(403).json({ message: "Access denied: insufficient permissions." });
      }

      // Keep the token-derived B. Buddy staff id (BB-110) — not on the DB row.
      req.user = { ...user, agentId: req.user.agentId ?? null };
      console.log("User authorized. Continuing to next middleware/route handler.");
      next();
    } catch (error) {
      console.error("Error in role middleware:", error);
      return res.status(500).json({ message: "Internal server error." });
    }
  };
}

module.exports = { authorizeRoles };
