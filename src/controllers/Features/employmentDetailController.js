// src/controllers/Features/employmentDetailController.js
/* eslint-disable consistent-return */
const { prisma } = require("@config/connection");
const { getVisibleCutoffPeriods } = require("@services/Cutoff/cutoffPeriodVisibilityService");

const buildPayload = (body) => ({
  jobTitle: body.jobTitle?.trim(),
  departmentId: body.departmentId || undefined,
  supervisorId: body.supervisorId || undefined,
  employmentStatus: body.employmentStatus || undefined,
  exemptStatus: body.exemptStatus || undefined,
  employmentType: body.employmentType || undefined,
  probationEndDate: body.probationEndDate ? new Date(body.probationEndDate) : undefined,
  workLocation: body.workLocation || undefined,
  timeZone: body.timeZone || undefined,
});

const getMyEmploymentDetails = async (req, res) => {
  try {
    const detail = await prisma.employmentDetail.findUnique({
      where: { userId: req.user.id },
      include: { department: true, supervisor: { select: { id: true, email: true } } },
    });

    const cutoffPeriods = await getVisibleCutoffPeriods({
      companyId: req.user.companyId,
      role: req.user.role,
      departmentId: detail?.departmentId,
    });

    return res.status(200).json({ data: detail, cutoffPeriods });
  } catch (e) {
    console.error("getMyEmploymentDetails:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const upsertMyEmploymentDetails = async (req, res) => {
  try {
    const data = buildPayload(req.body);
    const detail = await prisma.employmentDetail.upsert({
      where: { userId: req.user.id },
      create: { userId: req.user.id, ...data },
      update: data,
      include: { department: true, supervisor: { select: { id: true, email: true } } },
    });
    return res.status(200).json({ data: detail, message: "Employment details saved." });
  } catch (e) {
    console.error("upsertMyEmploymentDetails:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const getEmploymentDetailsById = async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await prisma.user.findUnique({ where: { id }, select: { companyId: true } });
    if (!employee) return res.status(404).json({ error: "User not found." });
    if (req.user.role !== "superadmin" && employee.companyId !== req.user.companyId) {
      return res.status(403).json({ error: "Unauthorized." });
    }

    const detail = await prisma.employmentDetail.findUnique({
      where: { userId: id },
      include: { department: true, supervisor: { select: { id: true, email: true } } },
    });
    return res.status(200).json({ data: detail });
  } catch (e) {
    console.error("getEmploymentDetailsById:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const upsertEmploymentDetailsById = async (req, res) => {
  try {
    const { id } = req.params;

    const employee = await prisma.user.findUnique({ where: { id }, select: { companyId: true } });
    if (!employee) return res.status(404).json({ error: "User not found." });
    if (req.user.role !== "superadmin" && employee.companyId !== req.user.companyId) {
      return res.status(403).json({ error: "Unauthorized." });
    }

    const data = buildPayload(req.body);

    const detail = await prisma.employmentDetail.upsert({
      where: { userId: id },
      create: { userId: id, ...data },
      update: data,
      include: { department: true, supervisor: { select: { id: true, email: true } } },
    });
    return res.status(200).json({ data: detail, message: "Employment details saved." });
  } catch (e) {
    console.error("upsertEmploymentDetailsById:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
};

module.exports = {
  getMyEmploymentDetails,
  upsertMyEmploymentDetails,
  getEmploymentDetailsById,
  upsertEmploymentDetailsById,
};
