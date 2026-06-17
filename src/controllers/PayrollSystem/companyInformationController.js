// src/controllers/PayrollSystem/companySettingsController.js

const { prisma } = require("@config/connection");

const VALIDATION_RULES = {
  MAX_LABEL_LENGTH: 100,
  MAX_DEDUCTION_TYPES: 50,
  VALID_PAY_FREQUENCIES: ['weekly', 'biweekly', 'semimonthly', 'monthly'],
};

const validateCode = (code) => {
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return { valid: false, error: 'Code is required' };
  }
  return { valid: true };
};

const validateLabel = (label) => {
  if (!label || typeof label !== 'string' || label.trim().length === 0) {
    return { valid: false, error: 'Label is required' };
  }
  if (label.length > VALIDATION_RULES.MAX_LABEL_LENGTH) {
    return { valid: false, error: 'Label is too long (max 100 characters)' };
  }
  return { valid: true };
};

const validatePayFrequency = (frequency) => {
  if (!VALIDATION_RULES.VALID_PAY_FREQUENCIES.includes(frequency)) {
    return { 
      valid: false, 
      error: `Pay frequency must be one of: ${VALIDATION_RULES.VALID_PAY_FREQUENCIES.join(', ')}` 
    };
  }
  return { valid: true };
};

// ============================================
// GET COMPANY SETTINGS (Everything in one call)
// ============================================

exports.getCompanySettings = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Fetch company info
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
      }
    });

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found."
      });
    }

    // Fetch or create payroll configuration
    let payrollConfig = await prisma.payrollConfiguration.findUnique({
      where: { companyId }
    });

    if (!payrollConfig) {
      // Create default config if doesn't exist
      payrollConfig = await prisma.payrollConfiguration.create({
        data: {
          companyId,
          payFrequency: 'biweekly',
          ptoEnabled: true,
          ptoLabel: 'PTO',
          futaEnabled: false,
          sutaEnabled: false,
          futaRate: 7,
        }
      });
    }

    // Fetch earning types
    const earningTypes = await prisma.earningType.findMany({
      where: { companyId },
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'asc' }
      ]
    });

    // Fetch deduction types
    const deductionTypes = await prisma.deductionType.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' }
    });

    return res.status(200).json({
      success: true,
      message: "Company settings retrieved successfully",
      data: {
        company: {
          id: company.id,
          name: company.name,
          address: company.addressLine1,
          city: company.city,
          state: company.state,
          zip: company.postalCode,
        },
        payrollConfig: {
          id: payrollConfig.id,
          payFrequency: payrollConfig.payFrequency,
          ptoEnabled: payrollConfig.ptoEnabled,
          ptoLabel: payrollConfig.ptoLabel,
          futaEnabled: payrollConfig.futaEnabled,
          sutaEnabled: payrollConfig.sutaEnabled,
          futaRate: parseFloat(payrollConfig.futaRate),
        },
        earningTypes: earningTypes.map(et => ({
          id: et.id,
          code: et.code,
          label: et.label,
          isTaxable: et.isTaxable,
          isDefault: et.isDefault,
          enabled: et.enabled,
        })),
        deductionTypes: deductionTypes.map(dt => ({
          id: dt.id,
          code: dt.code,
          label: dt.label,
          isPreTax: dt.isPreTax,
          enabled: dt.enabled,
        })),
      }
    });

  } catch (err) {
    console.error("getCompanySettings error:", err);
    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// UPDATE PAYROLL CONFIG
// ============================================

exports.updatePayrollConfig = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { payFrequency, ptoEnabled, ptoLabel, futaEnabled, sutaEnabled, futaRate } = req.body;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Validate pay frequency if provided
    if (payFrequency) {
      const validation = validatePayFrequency(payFrequency);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }
    }

    // Validate PTO label if provided
    if (ptoLabel !== undefined) {
      const validation = validateLabel(ptoLabel);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.error
        });
      }
    }

    // Build update data
    const updateData = {};
    if (payFrequency) updateData.payFrequency = payFrequency.toLowerCase();
    if (ptoEnabled !== undefined) updateData.ptoEnabled = Boolean(ptoEnabled);
    if (ptoLabel) updateData.ptoLabel = ptoLabel.trim();
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

    // Update or create
    const payrollConfig = await prisma.payrollConfiguration.upsert({
      where: { companyId },
      update: updateData,
      create: {
        companyId,
        payFrequency: payFrequency?.toLowerCase() || 'biweekly',
        ptoEnabled: ptoEnabled !== undefined ? Boolean(ptoEnabled) : true,
        ptoLabel: ptoLabel?.trim() || 'PTO',
        futaEnabled: futaEnabled !== undefined ? Boolean(futaEnabled) : false,
        sutaEnabled: sutaEnabled !== undefined ? Boolean(sutaEnabled) : false,
        futaRate:
          futaRate !== undefined && !Number.isNaN(parseFloat(futaRate))
            ? parseFloat(futaRate)
            : 7,
      }
    });

    return res.status(200).json({
      success: true,
      message: "Payroll configuration updated successfully",
      data: {
        id: payrollConfig.id,
        payFrequency: payrollConfig.payFrequency,
        ptoEnabled: payrollConfig.ptoEnabled,
        ptoLabel: payrollConfig.ptoLabel,
        futaEnabled: payrollConfig.futaEnabled,
        sutaEnabled: payrollConfig.sutaEnabled,
        futaRate: parseFloat(payrollConfig.futaRate),
      }
    });

  } catch (err) {
    console.error("updatePayrollConfig error:", err);
    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// UPDATE COMPANY INFO
// ============================================

exports.updateCompanyInfo = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { name, address, city, state, zip } = req.body;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Build update data
    const updateData = {};
    if (name) updateData.name = name.trim();
    if (address) updateData.addressLine1 = address.trim();
    if (city) updateData.city = city.trim();
    if (state) updateData.state = state.trim();
    if (zip) updateData.postalCode = zip.trim();

    const company = await prisma.company.update({
      where: { id: companyId },
      data: updateData,
      select: {
        id: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
      }
    });

    return res.status(200).json({
      success: true,
      message: "Company information updated successfully",
      data: {
        id: company.id,
        name: company.name,
        address: company.addressLine1,
        city: company.city,
        state: company.state,
        zip: company.postalCode,
      }
    });

  } catch (err) {
    console.error("updateCompanyInfo error:", err);
    
    if (err.code === 'P2002') {
      return res.status(400).json({
        success: false,
        message: "Company name already exists."
      });
    }

    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// CREATE EARNING TYPE
// ============================================

exports.createEarningType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { code, label, isTaxable = true } = req.body;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Validate code
    const codeValidation = validateCode(code);
    if (!codeValidation.valid) {
      return res.status(400).json({
        success: false,
        message: codeValidation.error
      });
    }

    // Validate label
    const labelValidation = validateLabel(label);
    if (!labelValidation.valid) {
      return res.status(400).json({
        success: false,
        message: labelValidation.error
      });
    }

    // Check max limit
    const count = await prisma.earningType.count({
      where: { companyId }
    });

    if (count >= VALIDATION_RULES.MAX_EARNING_TYPES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${VALIDATION_RULES.MAX_EARNING_TYPES} earning types allowed per company.`
      });
    }

    // Create earning type
    const earningType = await prisma.earningType.create({
      data: {
        companyId,
        code: code.trim(),
        label: label.trim(),
        isTaxable: Boolean(isTaxable),
        isDefault: false,
        enabled: true,
      }
    });

    return res.status(201).json({
      success: true,
      message: "Earning type created successfully",
      data: {
        id: earningType.id,
        code: earningType.code,
        label: earningType.label,
        isTaxable: earningType.isTaxable,
        isDefault: earningType.isDefault,
        enabled: earningType.enabled,
      }
    });

  } catch (err) {
    console.error("createEarningType error:", err);

    if (err.code === 'P2002') {
      return res.status(400).json({
        success: false,
        message: "An earning type with this code already exists."
      });
    }

    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// UPDATE EARNING TYPE
// ============================================

exports.updateEarningType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;
    const { code, label, isTaxable, enabled } = req.body;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Verify ownership
    const existing = await prisma.earningType.findFirst({
      where: { id, companyId }
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Earning type not found."
      });
    }

    // Build update data
    const updateData = {};

    if (code !== undefined) {
      const codeValidation = validateCode(code);
      if (!codeValidation.valid) {
        return res.status(400).json({
          success: false,
          message: codeValidation.error
        });
      }
      updateData.code = code.toLowerCase().trim();
    }

    if (label !== undefined) {
      const labelValidation = validateLabel(label);
      if (!labelValidation.valid) {
        return res.status(400).json({
          success: false,
          message: labelValidation.error
        });
      }
      updateData.label = label.trim();
    }

    if (isTaxable !== undefined) updateData.isTaxable = Boolean(isTaxable);
    if (enabled !== undefined) updateData.enabled = Boolean(enabled);

    // Update
    const earningType = await prisma.earningType.update({
      where: { id },
      data: updateData
    });

    return res.status(200).json({
      success: true,
      message: "Earning type updated successfully",
      data: {
        id: earningType.id,
        code: earningType.code,
        label: earningType.label,
        isTaxable: earningType.isTaxable,
        isDefault: earningType.isDefault,
        enabled: earningType.enabled,
      }
    });

  } catch (err) {
    console.error("updateEarningType error:", err);

    if (err.code === 'P2002') {
      return res.status(400).json({
        success: false,
        message: "An earning type with this code already exists."
      });
    }

    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// DELETE EARNING TYPE (Soft Delete)
// ============================================

exports.deleteEarningType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Verify ownership
    const existing = await prisma.earningType.findFirst({
      where: { id, companyId }
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Earning type not found."
      });
    }

    // Soft delete (set enabled to false)
    await prisma.earningType.update({
      where: { id },
      data: { enabled: false }
    });

    return res.status(200).json({
      success: true,
      message: "Earning type disabled successfully"
    });

  } catch (err) {
    console.error("deleteEarningType error:", err);
    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// ============================================
// CREATE DEDUCTION TYPE
// ============================================

exports.createDeductionType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { code, label, isPreTax = false } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const codeValidation = validateCode(code);
    if (!codeValidation.valid) {
      return res.status(400).json({
        success: false,
        message: codeValidation.error,
      });
    }

    const labelValidation = validateLabel(label);
    if (!labelValidation.valid) {
      return res.status(400).json({
        success: false,
        message: labelValidation.error,
      });
    }

    const count = await prisma.deductionType.count({
      where: { companyId },
    });

    if (count >= VALIDATION_RULES.MAX_DEDUCTION_TYPES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${VALIDATION_RULES.MAX_DEDUCTION_TYPES} deduction types allowed per company.`,
      });
    }

    const deductionType = await prisma.deductionType.create({
      data: {
        companyId,
        code: code.trim(),
        label: label.trim(),
        isPreTax: Boolean(isPreTax),
        enabled: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Deduction type created successfully",
      data: {
        id: deductionType.id,
        code: deductionType.code,
        label: deductionType.label,
        isPreTax: deductionType.isPreTax,
        enabled: deductionType.enabled,
      },
    });
  } catch (err) {
    console.error("createDeductionType error:", err);

    if (err.code === "P2002") {
      return res.status(400).json({
        success: false,
        message: "A deduction type with this code already exists.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPDATE DEDUCTION TYPE
// ============================================

exports.updateDeductionType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;
    const { code, label, isPreTax, enabled } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const existing = await prisma.deductionType.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Deduction type not found.",
      });
    }

    const updateData = {};

    if (code !== undefined) {
      const codeValidation = validateCode(code);
      if (!codeValidation.valid) {
        return res.status(400).json({
          success: false,
          message: codeValidation.error,
        });
      }
      updateData.code = code.toLowerCase().trim();
    }

    if (label !== undefined) {
      const labelValidation = validateLabel(label);
      if (!labelValidation.valid) {
        return res.status(400).json({
          success: false,
          message: labelValidation.error,
        });
      }
      updateData.label = label.trim();
    }

    if (isPreTax !== undefined) updateData.isPreTax = Boolean(isPreTax);
    if (enabled !== undefined) updateData.enabled = Boolean(enabled);

    const deductionType = await prisma.deductionType.update({
      where: { id },
      data: updateData,
    });

    return res.status(200).json({
      success: true,
      message: "Deduction type updated successfully",
      data: {
        id: deductionType.id,
        code: deductionType.code,
        label: deductionType.label,
        isPreTax: deductionType.isPreTax,
        enabled: deductionType.enabled,
      },
    });
  } catch (err) {
    console.error("updateDeductionType error:", err);

    if (err.code === "P2002") {
      return res.status(400).json({
        success: false,
        message: "A deduction type with this code already exists.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// DELETE DEDUCTION TYPE (Soft Delete)
// ============================================

exports.deleteDeductionType = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const existing = await prisma.deductionType.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Deduction type not found.",
      });
    }

    await prisma.deductionType.update({
      where: { id },
      data: { enabled: false },
    });

    return res.status(200).json({
      success: true,
      message: "Deduction type disabled successfully",
    });
  } catch (err) {
    console.error("deleteDeductionType error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};
