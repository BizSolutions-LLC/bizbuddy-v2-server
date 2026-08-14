// src/controllers/PayrollSystem/companySettingsController.js

const { prisma } = require("@config/connection");

const VALIDATION_RULES = {
  MAX_LABEL_LENGTH: 100,
  MAX_DEDUCTION_TYPES: 50,
  MAX_FEDERAL_TAX_RATES: 50,
  VALID_PAY_FREQUENCIES: ['weekly', 'biweekly', 'semimonthly', 'monthly'],
  VALID_FILING_STATUSES: ['single', 'married_filing_separately', 'head_of_household'],
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

const DEDUCTION_RATE_DEFAULTS = {
  stateIncomeTaxRate: 5,
  ficaRate: 6.2,
  medicareRate: 1.45,
  sdiRate: 1.1,
};

const validatePercentageRate = (value, fieldName) => {
  const rate = parseFloat(value);
  if (Number.isNaN(rate) || rate < 0 || rate > 100) {
    return {
      valid: false,
      error: `A valid ${fieldName} between 0 and 100 is required.`,
    };
  }
  return { valid: true, rate };
};

const validateFilingStatus = (filingStatus) => {
  if (!VALIDATION_RULES.VALID_FILING_STATUSES.includes(filingStatus)) {
    return {
      valid: false,
      error: `filingStatus must be one of: ${VALIDATION_RULES.VALID_FILING_STATUSES.join(', ')}`,
    };
  }
  return { valid: true };
};

const validateAnnualIncomeRange = (minAnnualIncome, maxAnnualIncome) => {
  const min = parseFloat(minAnnualIncome);
  if (Number.isNaN(min) || min < 0) {
    return { valid: false, error: 'A valid non-negative minAnnualIncome is required.' };
  }

  let max = null;
  if (maxAnnualIncome !== undefined && maxAnnualIncome !== null) {
    max = parseFloat(maxAnnualIncome);
    if (Number.isNaN(max) || max <= min) {
      return { valid: false, error: 'maxAnnualIncome must be greater than minAnnualIncome, or omitted for the top bracket.' };
    }
  }

  return { valid: true, min, max };
};

// Default federal bracket seed data (Single / Head of Household / Married
// Filing Separately only, per business decision) — used to give a new
// company sensible starting brackets instead of an empty table.
const DEFAULT_FEDERAL_TAX_BRACKETS = [
  // Single
  { filingStatus: 'single', minAnnualIncome: 0, maxAnnualIncome: 12400, rate: 10 },
  { filingStatus: 'single', minAnnualIncome: 12401, maxAnnualIncome: 50400, rate: 12 },
  { filingStatus: 'single', minAnnualIncome: 50401, maxAnnualIncome: 105700, rate: 22 },
  { filingStatus: 'single', minAnnualIncome: 105701, maxAnnualIncome: 201775, rate: 24 },
  { filingStatus: 'single', minAnnualIncome: 201776, maxAnnualIncome: 256225, rate: 32 },
  { filingStatus: 'single', minAnnualIncome: 256226, maxAnnualIncome: 640600, rate: 35 },
  { filingStatus: 'single', minAnnualIncome: 640601, maxAnnualIncome: null, rate: 37 },
  // Head of Household
  { filingStatus: 'head_of_household', minAnnualIncome: 0, maxAnnualIncome: 17700, rate: 10 },
  { filingStatus: 'head_of_household', minAnnualIncome: 17701, maxAnnualIncome: 67450, rate: 12 },
  { filingStatus: 'head_of_household', minAnnualIncome: 67451, maxAnnualIncome: 105700, rate: 22 },
  { filingStatus: 'head_of_household', minAnnualIncome: 105701, maxAnnualIncome: 201750, rate: 24 },
  { filingStatus: 'head_of_household', minAnnualIncome: 201751, maxAnnualIncome: 256200, rate: 32 },
  { filingStatus: 'head_of_household', minAnnualIncome: 256201, maxAnnualIncome: 640600, rate: 35 },
  { filingStatus: 'head_of_household', minAnnualIncome: 640601, maxAnnualIncome: null, rate: 37 },
  // Married Filing Separately
  { filingStatus: 'married_filing_separately', minAnnualIncome: 0, maxAnnualIncome: 12400, rate: 10 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 12401, maxAnnualIncome: 50400, rate: 12 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 50401, maxAnnualIncome: 105700, rate: 22 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 105701, maxAnnualIncome: 201775, rate: 24 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 201776, maxAnnualIncome: 256225, rate: 32 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 256226, maxAnnualIncome: 384350, rate: 35 },
  { filingStatus: 'married_filing_separately', minAnnualIncome: 384351, maxAnnualIncome: null, rate: 37 },
];

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
          ...DEDUCTION_RATE_DEFAULTS,
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
          stateIncomeTaxRate: parseFloat(payrollConfig.stateIncomeTaxRate),
          ficaRate: parseFloat(payrollConfig.ficaRate),
          medicareRate: parseFloat(payrollConfig.medicareRate),
          sdiRate: parseFloat(payrollConfig.sdiRate),
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
    const {
      payFrequency,
      ptoEnabled,
      ptoLabel,
      futaEnabled,
      sutaEnabled,
      futaRate,
      stateIncomeTaxRate,
      ficaRate,
      medicareRate,
      sdiRate,
    } = req.body;

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

    // Validate deduction tax rates if provided
    const deductionRateInputs = {
      stateIncomeTaxRate,
      ficaRate,
      medicareRate,
      sdiRate,
    };
    const validatedDeductionRates = {};
    for (const [field, value] of Object.entries(deductionRateInputs)) {
      if (value === undefined) continue;
      const validation = validatePercentageRate(value, field);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.error,
        });
      }
      validatedDeductionRates[field] = validation.rate;
    }

    // Build update data
    const updateData = { ...validatedDeductionRates };
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
        ...DEDUCTION_RATE_DEFAULTS,
        ...validatedDeductionRates,
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
        stateIncomeTaxRate: parseFloat(payrollConfig.stateIncomeTaxRate),
        ficaRate: parseFloat(payrollConfig.ficaRate),
        medicareRate: parseFloat(payrollConfig.medicareRate),
        sdiRate: parseFloat(payrollConfig.sdiRate),
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

const formatFederalTaxRate = (rate) => ({
  id: rate.id,
  filingStatus: rate.filingStatus,
  minAnnualIncome: parseFloat(rate.minAnnualIncome),
  maxAnnualIncome: rate.maxAnnualIncome != null ? parseFloat(rate.maxAnnualIncome) : null,
  rate: parseFloat(rate.rate),
  enabled: rate.enabled,
});

// ============================================
// LIST FEDERAL TAX RATES (Bracket table, per company)
// ============================================

exports.listFederalTaxRates = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const orderBy = [{ filingStatus: 'asc' }, { minAnnualIncome: 'asc' }];

    let rates = await prisma.federalTaxRate.findMany({
      where: { companyId },
      orderBy,
    });

    if (rates.length === 0) {
      // Seed sensible defaults so a company isn't starting from an empty table
      await prisma.federalTaxRate.createMany({
        data: DEFAULT_FEDERAL_TAX_BRACKETS.map((bracket) => ({
          companyId,
          ...bracket,
        })),
      });
      rates = await prisma.federalTaxRate.findMany({
        where: { companyId },
        orderBy,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Federal tax rates retrieved successfully",
      data: rates.map(formatFederalTaxRate),
    });
  } catch (err) {
    console.error("listFederalTaxRates error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// CREATE FEDERAL TAX RATE (Bracket row)
// ============================================

exports.createFederalTaxRate = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { filingStatus, minAnnualIncome, maxAnnualIncome, rate } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const filingStatusValidation = validateFilingStatus(filingStatus);
    if (!filingStatusValidation.valid) {
      return res.status(400).json({
        success: false,
        message: filingStatusValidation.error,
      });
    }

    const rangeValidation = validateAnnualIncomeRange(minAnnualIncome, maxAnnualIncome);
    if (!rangeValidation.valid) {
      return res.status(400).json({
        success: false,
        message: rangeValidation.error,
      });
    }

    const rateValidation = validatePercentageRate(rate, 'rate');
    if (!rateValidation.valid) {
      return res.status(400).json({
        success: false,
        message: rateValidation.error,
      });
    }

    const count = await prisma.federalTaxRate.count({ where: { companyId } });
    if (count >= VALIDATION_RULES.MAX_FEDERAL_TAX_RATES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${VALIDATION_RULES.MAX_FEDERAL_TAX_RATES} federal tax rate brackets allowed per company.`,
      });
    }

    const created = await prisma.federalTaxRate.create({
      data: {
        companyId,
        filingStatus,
        minAnnualIncome: rangeValidation.min,
        maxAnnualIncome: rangeValidation.max,
        rate: rateValidation.rate,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Federal tax rate bracket created successfully",
      data: formatFederalTaxRate(created),
    });
  } catch (err) {
    console.error("createFederalTaxRate error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPDATE FEDERAL TAX RATE (Bracket row)
// ============================================

exports.updateFederalTaxRate = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;
    const { filingStatus, minAnnualIncome, maxAnnualIncome, rate, enabled } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const existing = await prisma.federalTaxRate.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Federal tax rate bracket not found.",
      });
    }

    const updateData = {};

    if (filingStatus !== undefined) {
      const filingStatusValidation = validateFilingStatus(filingStatus);
      if (!filingStatusValidation.valid) {
        return res.status(400).json({
          success: false,
          message: filingStatusValidation.error,
        });
      }
      updateData.filingStatus = filingStatus;
    }

    if (minAnnualIncome !== undefined || maxAnnualIncome !== undefined) {
      const rangeValidation = validateAnnualIncomeRange(
        minAnnualIncome !== undefined ? minAnnualIncome : existing.minAnnualIncome,
        maxAnnualIncome !== undefined ? maxAnnualIncome : existing.maxAnnualIncome
      );
      if (!rangeValidation.valid) {
        return res.status(400).json({
          success: false,
          message: rangeValidation.error,
        });
      }
      updateData.minAnnualIncome = rangeValidation.min;
      updateData.maxAnnualIncome = rangeValidation.max;
    }

    if (rate !== undefined) {
      const rateValidation = validatePercentageRate(rate, 'rate');
      if (!rateValidation.valid) {
        return res.status(400).json({
          success: false,
          message: rateValidation.error,
        });
      }
      updateData.rate = rateValidation.rate;
    }

    if (enabled !== undefined) updateData.enabled = Boolean(enabled);

    const updated = await prisma.federalTaxRate.update({
      where: { id },
      data: updateData,
    });

    return res.status(200).json({
      success: true,
      message: "Federal tax rate bracket updated successfully",
      data: formatFederalTaxRate(updated),
    });
  } catch (err) {
    console.error("updateFederalTaxRate error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// DELETE FEDERAL TAX RATE (Soft Delete)
// ============================================

exports.deleteFederalTaxRate = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { id } = req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    const existing = await prisma.federalTaxRate.findFirst({
      where: { id, companyId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Federal tax rate bracket not found.",
      });
    }

    await prisma.federalTaxRate.update({
      where: { id },
      data: { enabled: false },
    });

    return res.status(200).json({
      success: true,
      message: "Federal tax rate bracket disabled successfully",
    });
  } catch (err) {
    console.error("deleteFederalTaxRate error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};
