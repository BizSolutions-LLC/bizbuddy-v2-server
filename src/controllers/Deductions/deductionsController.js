// src/controllers/Deductions/deductionsController.js

const { prisma } = require("@config/connection");

const DEFAULT_FUTA_BALANCE = 7000;

const getOrCreatePayrollConfig = async (companyId) => {
  let payrollConfig = await prisma.payrollConfiguration.findUnique({
    where: { companyId },
  });

  if (!payrollConfig) {
    payrollConfig = await prisma.payrollConfiguration.create({
      data: {
        companyId,
        payFrequency: "biweekly",
        ptoEnabled: true,
        ptoLabel: "PTO",
        futaEnabled: false,
        sutaEnabled: false,
        futaRate: 7,
      },
    });
  }

  return payrollConfig;
};

const verifyCompanyEmployee = async (companyId, userId) => {
  return prisma.user.findFirst({
    where: { id: userId, companyId },
    select: { id: true },
  });
};

const getCurrentFutaBalance = async (userId) => {
  const payrollDetails = await prisma.employeePayrollDetails.findUnique({
    where: { userId },
    select: { futaBalance: true },
  });

  return payrollDetails
    ? parseFloat(payrollDetails.futaBalance)
    : DEFAULT_FUTA_BALANCE;
};

// ============================================
// GET UNEMPLOYMENT TAX SETTINGS
// ============================================

exports.getUnemploymentTaxSettings = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const payrollConfig = await getOrCreatePayrollConfig(companyId);

    return res.status(200).json({
      success: true,
      message: "Unemployment tax settings retrieved successfully",
      data: {
        futaEnabled: payrollConfig.futaEnabled,
        sutaEnabled: payrollConfig.sutaEnabled,
        futaRate: parseFloat(payrollConfig.futaRate),
      },
    });
  } catch (err) {
    console.error("getUnemploymentTaxSettings error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPDATE UNEMPLOYMENT TAX SETTINGS
// ============================================

exports.updateUnemploymentTaxSettings = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { futaEnabled, sutaEnabled, futaRate } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    if (
      futaEnabled === undefined &&
      sutaEnabled === undefined &&
      futaRate === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "At least one of futaEnabled, sutaEnabled, or futaRate is required.",
      });
    }

    const updateData = {};
    if (futaEnabled !== undefined) updateData.futaEnabled = Boolean(futaEnabled);
    if (sutaEnabled !== undefined) updateData.sutaEnabled = Boolean(sutaEnabled);
    if (futaRate !== undefined) {
      const rate = parseFloat(futaRate);
      if (Number.isNaN(rate) || rate < 0) {
        return res.status(400).json({
          success: false,
          message: "A valid non-negative futaRate is required.",
        });
      }
      updateData.futaRate = rate;
    }

    const payrollConfig = await prisma.payrollConfiguration.upsert({
      where: { companyId },
      update: updateData,
      create: {
        companyId,
        payFrequency: "biweekly",
        ptoEnabled: true,
        ptoLabel: "PTO",
        futaEnabled: futaEnabled !== undefined ? Boolean(futaEnabled) : false,
        sutaEnabled: sutaEnabled !== undefined ? Boolean(sutaEnabled) : false,
        futaRate:
          futaRate !== undefined && !Number.isNaN(parseFloat(futaRate))
            ? parseFloat(futaRate)
            : 7,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Unemployment tax settings updated successfully",
      data: {
        futaEnabled: payrollConfig.futaEnabled,
        sutaEnabled: payrollConfig.sutaEnabled,
        futaRate: parseFloat(payrollConfig.futaRate),
      },
    });
  } catch (err) {
    console.error("updateUnemploymentTaxSettings error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// GET FUTA RATE
// ============================================

exports.getFutaRate = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const payrollConfig = await getOrCreatePayrollConfig(companyId);

    return res.status(200).json({
      success: true,
      message: "FUTA rate retrieved successfully",
      data: {
        futaRate: parseFloat(payrollConfig.futaRate),
      },
    });
  } catch (err) {
    console.error("getFutaRate error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPDATE FUTA RATE
// ============================================

exports.updateFutaRate = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { futaRate } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const rate = parseFloat(futaRate);
    if (futaRate === undefined || Number.isNaN(rate) || rate < 0) {
      return res.status(400).json({
        success: false,
        message: "A valid non-negative futaRate is required.",
      });
    }

    const payrollConfig = await prisma.payrollConfiguration.upsert({
      where: { companyId },
      update: { futaRate: rate },
      create: {
        companyId,
        payFrequency: "biweekly",
        ptoEnabled: true,
        ptoLabel: "PTO",
        futaEnabled: false,
        sutaEnabled: false,
        futaRate: rate,
      },
    });

    return res.status(200).json({
      success: true,
      message: "FUTA rate updated successfully",
      data: {
        futaRate: parseFloat(payrollConfig.futaRate),
      },
    });
  } catch (err) {
    console.error("updateFutaRate error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// GET FUTA BALANCE
// ============================================

exports.getFutaBalance = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const employee = await verifyCompanyEmployee(companyId, userId);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    const futaBalance = await getCurrentFutaBalance(userId);

    return res.status(200).json({
      success: true,
      message: "FUTA balance retrieved successfully",
      data: {
        userId,
        futaBalance,
      },
    });
  } catch (err) {
    console.error("getFutaBalance error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// DEDUCT FUTA BALANCE
// ============================================

exports.deductFutaBalance = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;
    const { amount } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const deductionAmount = parseFloat(amount);
    if (amount === undefined || Number.isNaN(deductionAmount) || deductionAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "A valid non-negative amount is required.",
      });
    }

    const employee = await verifyCompanyEmployee(companyId, userId);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    const currentBalance = await getCurrentFutaBalance(userId);
    const newBalance = Math.max(0, currentBalance - deductionAmount);

    const payrollDetails = await prisma.employeePayrollDetails.upsert({
      where: { userId },
      create: {
        userId,
        futaBalance: newBalance,
      },
      update: {
        futaBalance: newBalance,
      },
      select: {
        futaBalance: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "FUTA balance deducted successfully",
      data: {
        userId,
        previousBalance: currentBalance,
        deducted: deductionAmount,
        futaBalance: parseFloat(payrollDetails.futaBalance),
      },
    });
  } catch (err) {
    console.error("deductFutaBalance error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPDATE FUTA BALANCE
// ============================================

exports.updateFutaBalance = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;
    const { futaBalance } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const newBalance = parseFloat(futaBalance);
    if (futaBalance === undefined || Number.isNaN(newBalance) || newBalance < 0) {
      return res.status(400).json({
        success: false,
        message: "A valid non-negative futaBalance is required.",
      });
    }

    const employee = await verifyCompanyEmployee(companyId, userId);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    const payrollDetails = await prisma.employeePayrollDetails.upsert({
      where: { userId },
      create: {
        userId,
        futaBalance: newBalance,
      },
      update: {
        futaBalance: newBalance,
      },
      select: {
        futaBalance: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "FUTA balance updated successfully",
      data: {
        userId,
        futaBalance: parseFloat(payrollDetails.futaBalance),
      },
    });
  } catch (err) {
    console.error("updateFutaBalance error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};
