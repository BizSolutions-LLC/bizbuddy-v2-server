// src/utils/supervisorValidation.js
const { prisma } = require("@config/connection");

// BB-055: a direct supervisor must be an active supervisor/admin/superadmin
// in the same company, and an employee can't be assigned as their own supervisor.
// Returns an error message string if invalid, or null if the assignment is OK
// (including the case where supervisorId is empty — clearing the field is always allowed).
async function validateSupervisorId({ supervisorId, companyId, targetUserId }) {
  if (!supervisorId) return null;

  if (targetUserId && supervisorId === targetUserId) {
    return "An employee cannot be assigned as their own supervisor.";
  }

  const candidate = await prisma.user.findFirst({
    where: {
      id: supervisorId,
      companyId,
      status: "active",
      role: { in: ["supervisor", "admin", "superadmin"] },
    },
    select: { id: true },
  });

  if (!candidate) {
    return "Supervisor must be an active supervisor, admin, or superadmin in your company.";
  }

  return null;
}

module.exports = { validateSupervisorId };
