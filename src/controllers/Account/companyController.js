// src/controllers/Account/companyController.js
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

const currentSubSelect = {
  take: 1,
  orderBy: { startDate: "desc" },
  where: { OR: [{ active: true }, { endDate: { gt: new Date() } }] },
  select: { startDate: true, endDate: true },
};

const baseSelect = {
  id: true,
  name: true,
  dba: true,
  ein: true,
  stateTaxIds: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  phoneNumber: true,
  businessEmail: true,
  websiteUrl: true,
  currency: true,
  language: true,
  createdAt: true,
  updatedAt: true,
  Subscription: currentSubSelect,
};

const getAllCompanies = async (_req, res) => {
  try {
    const companies = await prisma.company.findMany({
      select: baseSelect,
      orderBy: { id: "asc" },
    });
    return res.status(200).json({ data: companies });
  } catch (error) {
    console.error("Error in getAllCompanies:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getCompanyById = async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      select: {
        ...baseSelect,
        Subscription: { orderBy: { startDate: "desc" }, include: { plan: true } },
      },
    });
    if (!company) return res.status(404).json({ message: "Company not found." });
    return res.status(200).json({ data: company });
  } catch (error) {
    console.error("Error in getCompanyById:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const createCompany = async (req, res) => {
  try {
    const {
      name,
      dba,
      ein,
      stateTaxIds,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      phoneNumber,
      businessEmail,
      websiteUrl,
      currency,
      language,
    } = req.body;

    if (!name || !country || !currency || !language) {
      return res.status(400).json({ message: "name, country, currency and language are required." });
    }

    //  Check unique EIN (if provided)
    if (ein) {
      const einExists = await prisma.company.findUnique({ where: { ein } });
      if (einExists) return res.status(409).json({ message: "EIN already in use." });
    }

    const newCompany = await prisma.company.create({
      data: {
        name: name.trim(),
        dba: dba?.trim(),
        ein: ein?.trim(),
        stateTaxIds,
        addressLine1: addressLine1?.trim(),
        addressLine2: addressLine2?.trim(),
        city: city?.trim(),
        state: state?.trim(),
        postalCode: postalCode?.trim(),
        country: country?.trim(),
        phoneNumber: phoneNumber?.trim(),
        businessEmail: businessEmail?.trim().toLowerCase(),
        websiteUrl: websiteUrl?.trim(),
        currency: currency?.trim(),
        language: language?.trim(),
      },
      select: baseSelect,
    });

    return res.status(201).json({ message: "Company created successfully.", data: newCompany });
  } catch (error) {
    console.error("Error in createCompany:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updateCompany = async (req, res) => {
  try {
    const companyId = req.params.id;

    const {
      name,
      dba,
      ein,
      stateTaxIds,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      phoneNumber,
      businessEmail,
      websiteUrl,
      currency,
      language,
    } = req.body;

    if (
      !name &&
      !dba &&
      !ein &&
      !stateTaxIds &&
      !addressLine1 &&
      !addressLine2 &&
      !city &&
      !state &&
      !postalCode &&
      !country &&
      !phoneNumber &&
      !businessEmail &&
      !websiteUrl &&
      !currency &&
      !language
    ) {
      return res.status(400).json({ message: "At least one field must be provided for update." });
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ message: "Company not found." });

    if (ein && ein !== company.ein) {
      const einExists = await prisma.company.findUnique({ where: { ein } });
      if (einExists) return res.status(409).json({ message: "Another company already uses this EIN." });
    }

    const updated = await prisma.company.update({
      where: { id: companyId },
      data: {
        name: name?.trim(),
        dba: dba?.trim(),
        ein: ein?.trim(),
        stateTaxIds,
        addressLine1: addressLine1?.trim(),
        addressLine2: addressLine2?.trim(),
        city: city?.trim(),
        state: state?.trim(),
        postalCode: postalCode?.trim(),
        country: country?.trim(),
        phoneNumber: phoneNumber?.trim(),
        businessEmail: businessEmail?.trim().toLowerCase(),
        websiteUrl: websiteUrl?.trim(),
        currency: currency?.trim(),
        language: language?.trim(),
      },
      select: baseSelect,
    });

    return res.status(200).json({ message: "Company updated successfully.", data: updated });
  } catch (error) {
    console.error("Error in updateCompany:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const companyId = req.params.id;
    await prisma.company.delete({ where: { id: companyId } });
    return res.status(200).json({ message: "Company deleted successfully." });
  } catch (error) {
    console.error("Error in deleteCompany:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getCompanyUserCount = async (req, res) => {
  try {
    const companyId = req.params.id;
    const count = await prisma.user.count({ where: { ...HUMAN_ONLY, companyId } });
    return res.status(200).json({ data: { companyId, userCount: count } });
  } catch (error) {
    console.error("Error in getCompanyUserCount:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getMyCompany = async (req, res) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.user.companyId },
      select: baseSelect,
    });
    if (!company) return res.status(404).json({ message: "Company not found." });
    return res.status(200).json({ data: company });
  } catch (err) {
    console.error("getMyCompany:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updateMyCompany = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) return res.status(400).json({ message: "No company on your account." });

    req.params.id = companyId;
    return updateCompany(req, res);
  } catch (err) {
    console.error("updateMyCompany:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getCompanyScheduleStats = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const now = new Date();

    const totalSchedules = await prisma.shiftSchedule.count({
      where: { companyId },
    });

    // FIX: Prisma 6.x no longer accepts bare { endDate: null } inside OR.
    // Must use { endDate: { equals: null } } explicitly.
    const activeSchedules = await prisma.shiftSchedule.count({
      where: {
        companyId,
        isActive: true,
        endDate: { gte: now },
      },
    });

    const assignedEmployeesCount = await prisma.userShift.groupBy({
      by: ["userId"],
      where: {
        shift: { companyId },
        assignedDate: { gte: now },
      },
    });

    // FIX: Compute avgDaysPerSchedule from real daysOfWeek data
    // instead of the previous hardcoded 4.5
    let avgDaysPerSchedule = 0;
    if (totalSchedules > 0) {
      const allSchedules = await prisma.shiftSchedule.findMany({
        where: { companyId },
        select: { daysOfWeek: true },
      });
      const totalDays = allSchedules.reduce(
        (sum, s) => sum + (Array.isArray(s.daysOfWeek) ? s.daysOfWeek.length : 0),
        0
      );
      avgDaysPerSchedule = parseFloat((totalDays / totalSchedules).toFixed(1));
    }

    return res.status(200).json({
      message: "Company schedule statistics retrieved successfully.",
      data: {
        totalSchedules,
        activeSchedules,
        assignedEmployees: assignedEmployeesCount.length,
        avgDaysPerSchedule,
      },
    });
  } catch (error) {
    console.error("Error fetching company schedule stats:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
  getCompanyUserCount,
  getMyCompany,
  updateMyCompany,
  getCompanyScheduleStats,
};
