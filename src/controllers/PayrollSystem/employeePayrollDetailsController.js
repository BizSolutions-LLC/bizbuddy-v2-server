// src/controllers/PayrollSystem/employeePayrollDetailsController.js

const { prisma } = require("@config/connection");

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
            additionalFedIncomeTax: 0,
            additionalStateIncomeTax: 0,
            ptoHoursBalance: 0,
            futaBalance: 7000,
            skipFicaMedicare: false,
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
          additionalFedIncomeTax: parseFloat(
            payrollDetails.additionalFedIncomeTax,
          ),
          additionalStateIncomeTax: parseFloat(
            payrollDetails.additionalStateIncomeTax,
          ),
          ptoHoursBalance: parseFloat(payrollDetails.ptoHoursBalance),
          futaBalance: parseFloat(payrollDetails.futaBalance),
          skipFicaMedicare: payrollDetails.skipFicaMedicare,
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
      additionalFedIncomeTax,
      additionalStateIncomeTax,
      ptoHoursBalance,
      skipFicaMedicare,
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
    // to the "married_filing_separately" FederalTaxRate bracket for federal
    // withholding purposes, but stays "married" here; no employee-facing
    // change.
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

    // Build upsert data
    const payrollData = {};
    if (maritalStatus !== undefined) payrollData.maritalStatus = maritalStatus;
    if (payType !== undefined) payrollData.payType = payType;
    if (payRate !== undefined) payrollData.payRate = parseFloat(payRate) || 0;
    if (additionalFedIncomeTax !== undefined)
      payrollData.additionalFedIncomeTax =
        parseFloat(additionalFedIncomeTax) || 0;
    if (additionalStateIncomeTax !== undefined)
      payrollData.additionalStateIncomeTax =
        parseFloat(additionalStateIncomeTax) || 0;
    if (ptoHoursBalance !== undefined)
      payrollData.ptoHoursBalance = parseFloat(ptoHoursBalance) || 0;
    if (skipFicaMedicare !== undefined)
      payrollData.skipFicaMedicare = Boolean(skipFicaMedicare);
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
    if (earningRates && Array.isArray(earningRates)) {
      // Verify all earning types belong to this company and are custom_rate
      const earningTypeIds = earningRates.map((er) => er.earningTypeId);
      const validEarningTypes = await prisma.earningType.findMany({
        where: {
          id: { in: earningTypeIds },
          companyId,
          calculationType: "custom_rate",
        },
        select: { id: true },
      });

      const validIds = new Set(validEarningTypes.map((et) => et.id));

      // Upsert each earning rate
      for (const er of earningRates) {
        if (!validIds.has(er.earningTypeId)) {
          continue; // Skip invalid earning types
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
          additionalFedIncomeTax: parseFloat(
            updatedDetails.additionalFedIncomeTax,
          ),
          additionalStateIncomeTax: parseFloat(
            updatedDetails.additionalStateIncomeTax,
          ),
          ptoHoursBalance: parseFloat(updatedDetails.ptoHoursBalance),
          futaBalance: parseFloat(updatedDetails.futaBalance),
          skipFicaMedicare: updatedDetails.skipFicaMedicare,
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
          additionalFedIncomeTax: 0,
          additionalStateIncomeTax: 0,
          ptoHoursBalance: 0,
          futaBalance: 7000,
          skipFicaMedicare: false,
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
        additionalFedIncomeTax: 0,
        additionalStateIncomeTax: 0,
        ptoHoursBalance: 0,
        futaBalance: 7000,
        skipFicaMedicare: false,
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
          additionalFedIncomeTax: parseFloat(
            payrollDetails.additionalFedIncomeTax || 0,
          ),
          additionalStateIncomeTax: parseFloat(
            payrollDetails.additionalStateIncomeTax || 0,
          ),
          ptoHoursBalance: parseFloat(payrollDetails.ptoHoursBalance || 0),
          futaBalance: parseFloat(payrollDetails.futaBalance ?? 7000),
          skipFicaMedicare: payrollDetails.skipFicaMedicare || false,
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
