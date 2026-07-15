// src/services/Approvers/approverResolutionService.js
const { prisma } = require("@config/connection");

const displayName = (profile, fallback) =>
  profile ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || fallback : fallback;

// Company-wide admins/superadmins + supervisors in the requester's own department.
// Used as the fallback approver list for leave / punch-log-edit request dropdowns
// (GET /api/leaves/approvers).
async function getEligibleApprovers({ id: userId, companyId }) {
  const requester = await prisma.user.findUnique({
    where: { id: userId },
    select: { departmentId: true },
  });

  const roleConditions = [{ role: { in: ["admin", "superadmin"] } }];
  if (requester?.departmentId) {
    roleConditions.push({ role: "supervisor", departmentId: requester.departmentId });
  }

  const approvers = await prisma.user.findMany({
    where: {
      companyId,
      NOT: { id: userId },
      OR: roleConditions,
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

// Direct-supervisor resolution (GET /api/account/approver): department supervisor,
// individual employee supervisors, or users with the supervisor role in the same
// department. Falls back to company admins when the requester has no department.
// Returns null if the requester can't be resolved for the given company.
async function getDirectSupervisors({ id: userId, companyId }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { employmentDetail: true, department: true },
  });

  if (!user || user.companyId !== companyId) return null;

  const userDepartmentId = user.departmentId || user.employmentDetail?.departmentId;

  if (userDepartmentId) {
    const departmentSupervisors = await prisma.user.findMany({
      where: {
        companyId,
        OR: [
          { supervisedDepartments: { some: { id: userDepartmentId } } },
          { supervisedEmployees: { some: { departmentId: userDepartmentId } } },
          {
            role: "supervisor",
            OR: [
              { departmentId: userDepartmentId },
              { employmentDetail: { departmentId: userDepartmentId } },
            ],
          },
        ],
        status: "active",
      },
      select: {
        id: true, email: true, role: true,
        profile: { select: { firstName: true, lastName: true } },
        employmentDetail: { select: { jobTitle: true } },
      },
      distinct: ["id"],
    });

    return departmentSupervisors.map((s) => ({
      id: s.id,
      name: displayName(s.profile, s.email),
      email: s.email,
      role: s.role,
      jobTitle: s.employmentDetail?.jobTitle || "Supervisor",
    }));
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
