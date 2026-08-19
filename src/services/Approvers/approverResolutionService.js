// src/services/Approvers/approverResolutionService.js
const { prisma } = require("@config/connection");

const displayName = (profile, fallback) =>
  profile ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || fallback : fallback;

// Company-wide admins/superadmins only. Direct-supervisor selection is
// getDirectSupervisors's exclusive job (BB-072) — kept separate so the two
// functions' responsibilities never overlap.
async function getEligibleApprovers({ id: userId, companyId }) {
  const approvers = await prisma.user.findMany({
    where: {
      companyId,
      NOT: { id: userId },
      role: { in: ["admin", "superadmin"] },
    },
    select: {
      id: true, email: true, username: true, role: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });

  return approvers.map((a) => ({
    ...a,
    name: displayName(a.profile, a.username),
  }));
}

// Direct-supervisor resolution (GET /api/account/approver): the requester's
// individually assigned supervisor (employmentDetail.supervisorId), and nothing
// else — BB-072. Falls back to the company admin/superadmin list when no
// supervisor is assigned, or the assigned one is no longer active/valid. No
// department-level guessing. Returns null if the requester can't be resolved
// for the given company.
async function getDirectSupervisors({ id: userId, companyId }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { employmentDetail: true },
  });

  if (!user || user.companyId !== companyId) return null;

  const supervisorId = user.employmentDetail?.supervisorId;
  if (supervisorId) {
    const supervisor = await prisma.user.findFirst({
      where: { id: supervisorId, companyId, status: "active" },
      select: {
        id: true, email: true, role: true,
        profile: { select: { firstName: true, lastName: true } },
        employmentDetail: { select: { jobTitle: true } },
      },
    });
    if (supervisor) {
      return [{
        id: supervisor.id,
        name: displayName(supervisor.profile, supervisor.email),
        email: supervisor.email,
        role: supervisor.role,
        jobTitle: supervisor.employmentDetail?.jobTitle || "Supervisor",
      }];
    }
  }

  const companyAdmins = await prisma.user.findMany({
    where: { companyId, role: { in: ["admin", "superadmin"] }, status: "active" },
    select: {
      id: true, email: true, role: true,
      profile: { select: { firstName: true, lastName: true } },
      employmentDetail: { select: { jobTitle: true } },
    },
  });

  return companyAdmins.map((a) => ({
    id: a.id,
    name: displayName(a.profile, a.email),
    email: a.email,
    role: a.role,
    jobTitle: a.employmentDetail?.jobTitle || "Administrator",
  }));
}

module.exports = { getEligibleApprovers, getDirectSupervisors };
