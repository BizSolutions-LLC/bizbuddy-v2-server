// src/controllers/PayrollSystem/employeePayrollDetailsController.js

const { prisma } = require("@config/connection");

// Validates an optional flat percentage override (customFederalRate /
// customStateRate). Unlike the other payroll fields, `null` is a
// meaningful, explicit value here — it clears the override so the employee
// falls back to the company's bracket-based FederalTaxRate /
// StateIncomeTaxRate tables. Only call this when the field is present in
// the request body (`!== undefined`); omitted fields should be left alone.
const validateNullablePercentageRate = (value, fieldName) => {
  if (value === null) return { valid: true, rate: null };
  const rate = parseFloat(value);
  if (Number.isNaN(rate) || rate < 0 || rate > 100) {
    return {
      valid: false,
      error: `${fieldName} must be a number between 0 and 100, or null to clear it.`,
    };
  }
  return { valid: true, rate };
};

// Validates the optional per-employee driver pay rate. `null` is meaningful
// here too — it marks the employee as not having a driver rate (e.g. not a
// driver), distinct from `0`. Only call this when the field is present in
// the request body (`!== undefined`); omitted fields should be left alone.
const validateNullableDriverPayRate = (value) => {
  if (value === null) return { valid: true, rate: null };
  const rate = parseFloat(value);
  if (Number.isNaN(rate) || rate < 0) {
    return {
      valid: false,
      error: "driverPayRate must be a non-negative number, or null to clear it.",
    };
  }
  return { valid: true, rate };
};

const TAX_EXEMPTION_DEFAULTS = {
  federalIncomeTaxExempt: false,
  socialSecurityExempt: false,
  medicareExempt: false,
  caPitExempt: false,
  caSdiExempt: false,
  skipFicaMedicare: false,
};

// skipFicaMedicare is kept for older clients as the conjunction of
// socialSecurityExempt AND medicareExempt. Always derive it on read so
// the two representations cannot drift.
const formatTaxExemptions = (details) => {
  const socialSecurityExempt = Boolean(details?.socialSecurityExempt);
  const medicareExempt = Boolean(details?.medicareExempt);
  return {
    federalIncomeTaxExempt: Boolean(details?.federalIncomeTaxExempt),
    socialSecurityExempt,
    medicareExempt,
    caPitExempt: Boolean(details?.caPitExempt),
    caSdiExempt: Boolean(details?.caSdiExempt),
    skipFicaMedicare: socialSecurityExempt && medicareExempt,
  };
};

// Resolves the SS/Medicare pair and the legacy skipFicaMedicare flag.
// New fields win when present. skipFicaMedicare only sets both when
// neither new field is in the body.
const resolveFicaMedicareExemptions = (body, existing) => {
  const ssSent = body.socialSecurityExempt !== undefined;
  const medSent = body.medicareExempt !== undefined;
  const skipSent = body.skipFicaMedicare !== undefined;

  if (!ssSent && !medSent && !skipSent) return null;

  let socialSecurityExempt = Boolean(existing?.socialSecurityExempt);
  let medicareExempt = Boolean(existing?.medicareExempt);

  if (skipSent && !ssSent && !medSent) {
    socialSecurityExempt = Boolean(body.skipFicaMedicare);
    medicareExempt = Boolean(body.skipFicaMedicare);
  } else {
    if (ssSent) socialSecurityExempt = Boolean(body.socialSecurityExempt);
    if (medSent) medicareExempt = Boolean(body.medicareExempt);
  }

  return {
    socialSecurityExempt,
    medicareExempt,
    skipFicaMedicare: socialSecurityExempt && medicareExempt,
  };
};

// ============================================
// GET EMPLOYEE PAYROLL DETAILS
// ============================================

exports.getEmployeePayrollDetails = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    // Verify the user belongs to this company and get profile info
    const user = await prisma.user.findFirst({
      where: { id: userId, companyId },
      select: {
        id: true,
        username: true,
        status: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
            ssnItin: true,
            addressLine: true,
            city: true,
            state: true,
            postalCode: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    // Fetch payroll details with earning rates
    const payrollDetails = await prisma.employeePayrollDetails.findUnique({
      where: { userId },
      include: {
        earningRates: {
          include: {
            earningType: {
              select: {
                id: true,
                code: true,
                label: true,
                calculationType: true,
                enabled: true,
              },
            },
          },
        },
      },
    });

    // Fetch enabled custom_rate earning types for this company
    const customRateEarningTypes = await prisma.earningType.findMany({
      where: {
        companyId,
        calculationType: "custom_rate",
        enabled: true,
      },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        code: true,
        label: true,
      },
    });

    // Build employee info from profile
    const employeeInfo = {
      id: user.id,
      username: user.username,
      isActive: user.status === "active",
      firstName: user.profile?.firstName || "",
      lastName: user.profile?.lastName || "",
      ssnItin: user.profile?.ssnItin || "",
      address: user.profile?.addressLine || "",
      city: user.profile?.city || "",
      state: user.profile?.state || "",
      zip: user.profile?.postalCode || "",
      position: user.employmentDetail?.position || "",
      employmentStatus: user.employmentDetail?.status || "",
    };

    // If no payroll details exist, return defaults
    if (!payrollDetails) {
      return res.status(200).json({
        success: true,
        message: "No payroll details found, returning defaults.",
        data: {
          exists: false,
          employeeInfo,
          payrollDetails: {
            userId,
            maritalStatus: "single",
            payType: "hourly",
            payRate: 0,
            driverPayRate: null,
            additionalFedIncomeTax: 0,
            additionalStateIncomeTax: 0,
            customFederalRate: null,
            customStateRate: null,
            ptoHoursBalance: 0,
            futaBalance: 7000,
            ...TAX_EXEMPTION_DEFAULTS,
            withCalSavers: false,
          },
          earningRates: customRateEarningTypes.map((et) => ({
            earningTypeId: et.id,
            code: et.code,
            label: et.label,
            rate: 0,
          })),
        },
      });
    }

    // Build earning rates map (include types that may not have rates yet)
    const existingRatesMap = new Map(
      payrollDetails.earningRates.map((er) => [er.earningTypeId, er.rate]),
    );

    const earningRates = customRateEarningTypes.map((et) => ({
      earningTypeId: et.id,
      code: et.code,
      label: et.label,
      rate: existingRatesMap.get(et.id) || 0,
    }));

    return res.status(200).json({
      success: true,
      message: "Employee payroll details retrieved successfully.",
      data: {
        exists: true,
        employeeInfo,
        payrollDetails: {
          id: payrollDetails.id,
          userId: payrollDetails.userId,
          maritalStatus: payrollDetails.maritalStatus,
          payType: payrollDetails.payType,
          payRate: parseFloat(payrollDetails.payRate),
          driverPayRate:
            payrollDetails.driverPayRate != null
              ? parseFloat(payrollDetails.driverPayRate)
              : null,
          additionalFedIncomeTax: parseFloat(
            payrollDetails.additionalFedIncomeTax,
          ),
          additionalStateIncomeTax: parseFloat(
            payrollDetails.additionalStateIncomeTax,
          ),
          customFederalRate:
            payrollDetails.customFederalRate != null
              ? parseFloat(payrollDetails.customFederalRate)
              : null,
          customStateRate:
            payrollDetails.customStateRate != null
              ? parseFloat(payrollDetails.customStateRate)
              : null,
          ptoHoursBalance: parseFloat(payrollDetails.ptoHoursBalance),
          futaBalance: parseFloat(payrollDetails.futaBalance),
          ...formatTaxExemptions(payrollDetails),
          withCalSavers: payrollDetails.withCalSavers,
        },
        earningRates,
      },
    });
  } catch (err) {
    console.error("getEmployeePayrollDetails error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// UPSERT EMPLOYEE PAYROLL DETAILS
// ============================================

exports.upsertEmployeePayrollDetails = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;
    const {
      maritalStatus,
      payType,
      payRate,
      driverPayRate,
      additionalFedIncomeTax,
      additionalStateIncomeTax,
      customFederalRate,
      customStateRate,
      ptoHoursBalance,
      skipFicaMedicare,
      federalIncomeTaxExempt,
      socialSecurityExempt,
      medicareExempt,
      caPitExempt,
      caSdiExempt,
      withCalSavers,
      earningRates, // Array of { earningTypeId, rate }
    } = req.body;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    // Verify the user belongs to this company
    const user = await prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    // Validate maritalStatus — unchanged. "married" is treated as equivalent
    // to the "married_filing_separately" bracket for both FederalTaxRate and
    // StateIncomeTaxRate withholding purposes, but stays "married" here; no
    // employee-facing change.
    const validMaritalStatuses = ["single", "married", "head_of_household"];
    if (maritalStatus && !validMaritalStatuses.includes(maritalStatus)) {
      return res.status(400).json({
        success: false,
        message: `Marital status must be one of: ${validMaritalStatuses.join(", ")}`,
      });
    }

    // Validate payType
    const validPayTypes = ["hourly", "salary"];
    if (payType && !validPayTypes.includes(payType)) {
      return res.status(400).json({
        success: false,
        message: `Pay type must be one of: ${validPayTypes.join(", ")}`,
      });
    }

    // Validate custom rate overrides — null is allowed and means "clear the
    // override, use the company's bracket tables for this employee."
    let customFederalRateValidation;
    if (customFederalRate !== undefined) {
      customFederalRateValidation = validateNullablePercentageRate(
        customFederalRate,
        "customFederalRate",
      );
      if (!customFederalRateValidation.valid) {
        return res.status(400).json({
          success: false,
          message: customFederalRateValidation.error,
        });
      }
    }

    let customStateRateValidation;
    if (customStateRate !== undefined) {
      customStateRateValidation = validateNullablePercentageRate(
        customStateRate,
        "customStateRate",
      );
      if (!customStateRateValidation.valid) {
        return res.status(400).json({
          success: false,
          message: customStateRateValidation.error,
        });
      }
    }

    // Validate driverPayRate — null is allowed and means the employee has no
    // driver rate set (e.g. not a driver).
    let driverPayRateValidation;
    if (driverPayRate !== undefined) {
      driverPayRateValidation = validateNullableDriverPayRate(driverPayRate);
      if (!driverPayRateValidation.valid) {
        return res.status(400).json({
          success: false,
          message: driverPayRateValidation.error,
        });
      }
    }

    // Build upsert data
    const payrollData = {};
    if (maritalStatus !== undefined) payrollData.maritalStatus = maritalStatus;
    if (payType !== undefined) payrollData.payType = payType;
    if (payRate !== undefined) payrollData.payRate = parseFloat(payRate) || 0;
    if (driverPayRate !== undefined)
      payrollData.driverPayRate = driverPayRateValidation.rate;
    if (additionalFedIncomeTax !== undefined)
      payrollData.additionalFedIncomeTax =
        parseFloat(additionalFedIncomeTax) || 0;
    if (additionalStateIncomeTax !== undefined)
      payrollData.additionalStateIncomeTax =
        parseFloat(additionalStateIncomeTax) || 0;
    if (customFederalRate !== undefined)
      payrollData.customFederalRate = customFederalRateValidation.rate;
    if (customStateRate !== undefined)
      payrollData.customStateRate = customStateRateValidation.rate;
    if (ptoHoursBalance !== undefined)
      payrollData.ptoHoursBalance = parseFloat(ptoHoursBalance) || 0;
    if (federalIncomeTaxExempt !== undefined)
      payrollData.federalIncomeTaxExempt = Boolean(federalIncomeTaxExempt);
    if (caPitExempt !== undefined)
      payrollData.caPitExempt = Boolean(caPitExempt);
    if (caSdiExempt !== undefined)
      payrollData.caSdiExempt = Boolean(caSdiExempt);

    const ficaMedicareBody = {
      socialSecurityExempt,
      medicareExempt,
      skipFicaMedicare,
    };
    if (
      ficaMedicareBody.socialSecurityExempt !== undefined ||
      ficaMedicareBody.medicareExempt !== undefined ||
      ficaMedicareBody.skipFicaMedicare !== undefined
    ) {
      const existingExemptions =
        await prisma.employeePayrollDetails.findUnique({
          where: { userId },
          select: {
            socialSecurityExempt: true,
            medicareExempt: true,
          },
        });
      Object.assign(
        payrollData,
        resolveFicaMedicareExemptions(ficaMedicareBody, existingExemptions),
      );
    }

    if (withCalSavers !== undefined)
      payrollData.withCalSavers = Boolean(withCalSavers);

    // Upsert payroll details
    const payrollDetails = await prisma.employeePayrollDetails.upsert({
      where: { userId },
      create: {
        userId,
        ...payrollData,
      },
      update: payrollData,
    });

    // Handle earning rates if provided
    if (earningRates && Array.isArray(earningRates) && earningRates.length > 0) {
      // Prisma throws on `id: { in: [] }` — Employee Save always posts earningRates,
      // often empty when the company has no custom_rate types.
      const earningTypeIds = earningRates
        .map((er) => er.earningTypeId)
        .filter(Boolean);

      if (earningTypeIds.length > 0) {
        const validEarningTypes = await prisma.earningType.findMany({
          where: {
            id: { in: earningTypeIds },
            companyId,
            calculationType: "custom_rate",
          },
          select: { id: true },
        });

        const validIds = new Set(validEarningTypes.map((et) => et.id));

        for (const er of earningRates) {
          if (!validIds.has(er.earningTypeId)) {
            continue;
          }

          await prisma.employeeEarningRate.upsert({
            where: {
              employeePayrollDetailsId_earningTypeId: {
                employeePayrollDetailsId: payrollDetails.id,
                earningTypeId: er.earningTypeId,
              },
            },
            create: {
              employeePayrollDetailsId: payrollDetails.id,
              earningTypeId: er.earningTypeId,
              rate: parseFloat(er.rate) || 0,
            },
            update: {
              rate: parseFloat(er.rate) || 0,
            },
          });
        }
      }
    }

    // Fetch updated data with earning rates
    const updatedDetails = await prisma.employeePayrollDetails.findUnique({
      where: { userId },
      include: {
        earningRates: {
          include: {
            earningType: {
              select: {
                id: true,
                code: true,
                label: true,
              },
            },
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Employee payroll details saved successfully.",
      data: {
        payrollDetails: {
          id: updatedDetails.id,
          userId: updatedDetails.userId,
          maritalStatus: updatedDetails.maritalStatus,
          payType: updatedDetails.payType,
          payRate: parseFloat(updatedDetails.payRate),
          driverPayRate:
            updatedDetails.driverPayRate != null
              ? parseFloat(updatedDetails.driverPayRate)
              : null,
          additionalFedIncomeTax: parseFloat(
            updatedDetails.additionalFedIncomeTax,
          ),
          additionalStateIncomeTax: parseFloat(
            updatedDetails.additionalStateIncomeTax,
          ),
          customFederalRate:
            updatedDetails.customFederalRate != null
              ? parseFloat(updatedDetails.customFederalRate)
              : null,
          customStateRate:
            updatedDetails.customStateRate != null
              ? parseFloat(updatedDetails.customStateRate)
              : null,
          ptoHoursBalance: parseFloat(updatedDetails.ptoHoursBalance),
          futaBalance: parseFloat(updatedDetails.futaBalance),
          ...formatTaxExemptions(updatedDetails),
          withCalSavers: updatedDetails.withCalSavers,
        },
        earningRates: updatedDetails.earningRates.map((er) => ({
          earningTypeId: er.earningTypeId,
          code: er.earningType.code,
          label: er.earningType.label,
          rate: parseFloat(er.rate),
        })),
      },
    });
  } catch (err) {
    console.error("upsertEmployeePayrollDetails error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// RESET EMPLOYEE PAYROLL DETAILS TO DEFAULTS
// ============================================

exports.resetEmployeePayrollDetails = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { userId } = req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    // Verify the user belongs to this company
    const user = await prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Employee not found.",
      });
    }

    // Delete existing payroll details (cascades to earning rates)
    await prisma.employeePayrollDetails.deleteMany({
      where: { userId },
    });

    // Fetch custom_rate earning types for response
    const customRateEarningTypes = await prisma.earningType.findMany({
      where: {
        companyId,
        calculationType: "custom_rate",
        enabled: true,
      },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        code: true,
        label: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Employee payroll details reset to defaults.",
      data: {
        payrollDetails: {
          userId,
          maritalStatus: "single",
          payType: "hourly",
          payRate: 0,
          driverPayRate: null,
          additionalFedIncomeTax: 0,
          additionalStateIncomeTax: 0,
          customFederalRate: null,
          customStateRate: null,
          ptoHoursBalance: 0,
          futaBalance: 7000,
          ...TAX_EXEMPTION_DEFAULTS,
          withCalSavers: false,
        },
        earningRates: customRateEarningTypes.map((et) => ({
          earningTypeId: et.id,
          code: et.code,
          label: et.label,
          rate: 0,
        })),
      },
    });
  } catch (err) {
    console.error("resetEmployeePayrollDetails error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ============================================
// GET ALL EMPLOYEES WITH PAYROLL DETAILS
// (For Create Paycheck page - bulk fetch)
// ============================================

exports.getAllEmployeesWithPayrollDetails = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required.",
      });
    }

    // Fetch all active employees with their payroll details
    const employees = await prisma.user.findMany({
      where: {
        companyId,
        status: "active",
      },
      select: {
        id: true,
        username: true,
        email: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        employmentDetail: true,
        payrollDetails: {
          include: {
            earningRates: {
              include: {
                earningType: {
                  select: {
                    id: true,
                    code: true,
                    label: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { username: "asc" },
    });

    // Fetch enabled earning types
    const earningTypes = await prisma.earningType.findMany({
      where: { companyId, enabled: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        code: true,
        label: true,
        calculationType: true,
        isTaxable: true,
        otMultiplier: true,
      },
    });

    // Fetch enabled deduction types
    const deductionTypes = await prisma.deductionType.findMany({
      where: { companyId, enabled: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        code: true,
        label: true,
        isPreTax: true,
      },
    });

    // Format employee data
    const formattedEmployees = employees.map((emp) => {
      const fullName = emp.profile
        ? `${emp.profile.firstName || ""} ${emp.profile.lastName || ""}`.trim()
        : emp.username;

      const payrollDetails = emp.payrollDetails || {
        maritalStatus: "single",
        payType: "hourly",
        payRate: 0,
        driverPayRate: null,
        additionalFedIncomeTax: 0,
        additionalStateIncomeTax: 0,
        customFederalRate: null,
        customStateRate: null,
        ptoHoursBalance: 0,
        futaBalance: 7000,
        ...TAX_EXEMPTION_DEFAULTS,
        withCalSavers: false,
      };

      // Build earning rates map
      const earningRatesMap = {};
      if (emp.payrollDetails?.earningRates) {
        emp.payrollDetails.earningRates.forEach((er) => {
          earningRatesMap[er.earningTypeId] = parseFloat(er.rate);
        });
      }

      return {
        id: emp.id,
        name: fullName,
        email: emp.email,
        position: emp.employmentDetail?.jobTitle || "No position",
        status: emp.employmentDetail?.status || "Active",
        payrollDetails: {
          maritalStatus: payrollDetails.maritalStatus,
          payType: payrollDetails.payType,
          payRate: parseFloat(payrollDetails.payRate || 0),
          driverPayRate:
            payrollDetails.driverPayRate != null
              ? parseFloat(payrollDetails.driverPayRate)
              : null,
          additionalFedIncomeTax: parseFloat(
            payrollDetails.additionalFedIncomeTax || 0,
          ),
          additionalStateIncomeTax: parseFloat(
            payrollDetails.additionalStateIncomeTax || 0,
          ),
          customFederalRate:
            payrollDetails.customFederalRate != null
              ? parseFloat(payrollDetails.customFederalRate)
              : null,
          customStateRate:
            payrollDetails.customStateRate != null
              ? parseFloat(payrollDetails.customStateRate)
              : null,
          ptoHoursBalance: parseFloat(payrollDetails.ptoHoursBalance || 0),
          futaBalance: parseFloat(payrollDetails.futaBalance ?? 7000),
          ...formatTaxExemptions(payrollDetails),
          withCalSavers: payrollDetails.withCalSavers || false,
        },
        earningRates: earningRatesMap,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Employees with payroll details retrieved successfully.",
      data: {
        employees: formattedEmployees,
        earningTypes,
        deductionTypes,
      },
    });
  } catch (err) {
    console.error("getAllEmployeesWithPayrollDetails error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};
