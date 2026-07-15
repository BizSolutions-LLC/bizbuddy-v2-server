// src/services/Cutoff/cutoffPeriodVisibilityService.js
const { prisma } = require("@config/connection");

const COMPANY_WIDE_ROLES = new Set(["admin", "superadmin"]);

// Admins/superadmins aren't scoped to one department — they see every cutoff
// period for the company, same as the company-side view. Everyone else only
// sees their own department's periods plus any company-wide (no department) ones.
async function getVisibleCutoffPeriods({ companyId, role, departmentId }) {
  const isCompanyWideRole = COMPANY_WIDE_ROLES.has(role);

  return prisma.cutoffPeriod.findMany({
    where: {
      companyId,
      ...(isCompanyWideRole
        ? {}
        : departmentId
        ? { OR: [{ departmentId }, { departmentId: null }] }
        : { departmentId: null }),
    },
    select: { id: true, periodStart: true, periodEnd: true, status: true, departmentId: true },
    orderBy: { periodStart: "desc" },
  });
}

module.exports = { getVisibleCutoffPeriods };
