// src/controllers/Account/companySettingsController.js
const { prisma }           = require("@config/connection");
const { BNC_COMPANY_IDS }  = require("@config/companyTypes");

exports.getSettings = async (req, res) => {
  try {
    const company = await prisma.company.findFirst({
      where: { id: req.user.companyId },
      select: {
        id: true,
        name: true,
        defaultShiftHours: true,
        minimumLunchMinutes: true,
        gracePeriodMinutes: true,
        otBasis: true,
        dailyOtThresholdHours: true,
        weeklyOtThresholdHours: true,
        cutoffOtThresholdHours: true,
        country: true,
        currency: true,
        language: true,
        timeZone: true,
        driverAideThresholdMinutes:    true,
        shiftAssignmentWindowMinutes:  true,
        earlyClockInGraceMinutes:      true,
        earlyClockOutGraceMinutes:     true,
        autoClockOutWarningHours:      true,
        autoClockOutGraceHours:        true,
        autoClockOutNotifyEmails:      true,
        multiApprovalEnabled:          true,
        secondaryApproverId:           true,
        leaveConflictAutoRevert:       true,
        companyCutoffSettings:         true,
        autoBreakBasis:               true,
        autoLunchEnabled:             true,
        autoCoffeeEnabled:            true,
      },
    });
    const formatted = {
      ...company,
      timezone:                 company.timeZone,
      autoClockOutWarningHours: company.autoClockOutWarningHours != null
        ? parseFloat(company.autoClockOutWarningHours) : 0.5,
      autoClockOutGraceHours:   company.autoClockOutGraceHours != null
        ? parseFloat(company.autoClockOutGraceHours)   : 1.0,
      autoClockOutNotifyEmails: Array.isArray(company.autoClockOutNotifyEmails)
        ? company.autoClockOutNotifyEmails : [],
      cutoffSettings: company.companyCutoffSettings
        ? {
            seedStartDate:     company.companyCutoffSettings.seedStartDate.toISOString().slice(0, 10),
            durationDays:      company.companyCutoffSettings.durationDays,
            paymentOffsetDays: company.companyCutoffSettings.paymentOffsetDays,
          }
        : null,
    };

    delete formatted.timeZone;
    delete formatted.companyCutoffSettings;

    formatted.isBNC = BNC_COMPANY_IDS.has(company.id);

    return res.json({ data: formatted });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user.role))
      return res.status(403).json({ error: "Forbidden" });

    if (req.body.timezone && !req.body.timeZone) {
      req.body.timeZone = req.body.timezone;
    }

    const {
      defaultShiftHours,
      minimumLunchMinutes,
      gracePeriodMinutes,
      dailyOtThresholdHours,
      weeklyOtThresholdHours,
      cutoffOtThresholdHours,
      otBasis,
      country,
      currency,
      language,
      timeZone,
      driverAideThresholdMinutes,
      shiftAssignmentWindowMinutes,
      earlyClockInGraceMinutes,
      earlyClockOutGraceMinutes,
      autoClockOutWarningHours,
      autoClockOutGraceHours,
      autoClockOutNotifyEmails,
      multiApprovalEnabled,
      secondaryApproverId,
      leaveConflictAutoRevert,
      cutoffSettings,
      autoBreakBasis,
      autoLunchEnabled,
      autoCoffeeEnabled,
    } = req.body;

    const VALID_OT_BASES = ["daily", "weekly", "cutoff"];

    const updated = await prisma.company.update({
      where: { id: req.user.companyId },
      data: {
        ...(defaultShiftHours !== undefined && {
          defaultShiftHours:
            defaultShiftHours === null ? null : Number(defaultShiftHours) || null,
        }),
        ...(minimumLunchMinutes !== undefined && {
          minimumLunchMinutes:
            minimumLunchMinutes === null ? null : Number(minimumLunchMinutes) || 0,
        }),
        ...(gracePeriodMinutes !== undefined && {
          gracePeriodMinutes:
            gracePeriodMinutes === null ? 15 : Number(gracePeriodMinutes) || 15,
        }),
        // ── OT configuration ────────────────────────
        ...(otBasis !== undefined && {
          otBasis: VALID_OT_BASES.includes(otBasis) ? otBasis : "daily",
        }),
        ...(dailyOtThresholdHours !== undefined && {
          dailyOtThresholdHours:
            dailyOtThresholdHours === null ? 8 : Number(dailyOtThresholdHours) || 8,
        }),
        ...(weeklyOtThresholdHours !== undefined && {
          weeklyOtThresholdHours:
            weeklyOtThresholdHours === null ? 40 : Number(weeklyOtThresholdHours) || 40,
        }),
        ...(cutoffOtThresholdHours !== undefined && {
          cutoffOtThresholdHours:
            cutoffOtThresholdHours === null ? 80 : Number(cutoffOtThresholdHours) || 80,
        }),
        // ─────────────────────────────────────────────
        ...(timeZone !== undefined && { timeZone }),
        country,
        currency,
        language,
        ...(driverAideThresholdMinutes !== undefined &&
          driverAideThresholdMinutes !== null && {
            driverAideThresholdMinutes:
              Number.isInteger(driverAideThresholdMinutes) && driverAideThresholdMinutes > 0
                ? driverAideThresholdMinutes
                : undefined,
          }),
        ...(shiftAssignmentWindowMinutes !== undefined && {
          shiftAssignmentWindowMinutes:
            Number.isInteger(shiftAssignmentWindowMinutes) && shiftAssignmentWindowMinutes >= 0
              ? shiftAssignmentWindowMinutes
              : 30,
        }),
        ...(earlyClockInGraceMinutes !== undefined && {
          earlyClockInGraceMinutes:
            earlyClockInGraceMinutes === null
              ? null
              : Number.isInteger(earlyClockInGraceMinutes) && earlyClockInGraceMinutes > 0
                ? earlyClockInGraceMinutes
                : undefined,
        }),
        ...(earlyClockOutGraceMinutes !== undefined && {
          earlyClockOutGraceMinutes:
            earlyClockOutGraceMinutes === null
              ? 20
              : Number.isInteger(earlyClockOutGraceMinutes) && earlyClockOutGraceMinutes > 0
                ? earlyClockOutGraceMinutes
                : undefined,
        }),
        // ── Auto clock-out config ─────────────────────────────────────────────
        ...(autoClockOutWarningHours !== undefined && {
          autoClockOutWarningHours:
            autoClockOutWarningHours === null ? 0.5 : Math.max(0, Number(autoClockOutWarningHours) || 0.5),
        }),
        ...(autoClockOutGraceHours !== undefined && {
          autoClockOutGraceHours:
            autoClockOutGraceHours === null ? 1.0 : Math.max(0, Number(autoClockOutGraceHours) || 1.0),
        }),
        ...(autoClockOutNotifyEmails !== undefined && {
          autoClockOutNotifyEmails: Array.isArray(autoClockOutNotifyEmails)
            ? autoClockOutNotifyEmails.filter((e) => typeof e === "string" && e.trim())
            : [],
        }),
        ...(multiApprovalEnabled !== undefined && {
          multiApprovalEnabled: Boolean(multiApprovalEnabled),
        }),
        ...(secondaryApproverId !== undefined && {
          secondaryApproverId: secondaryApproverId || null,
        }),
        ...(leaveConflictAutoRevert !== undefined && {
          leaveConflictAutoRevert: Boolean(leaveConflictAutoRevert),
        }),
        // ── Auto-break configuration ──────────────────────────────────────────
        ...(autoBreakBasis !== undefined && {
          autoBreakBasis: ["department", "shift"].includes(autoBreakBasis) ? autoBreakBasis : null,
        }),
        ...(autoLunchEnabled !== undefined && { autoLunchEnabled: Boolean(autoLunchEnabled) }),
        ...(autoCoffeeEnabled !== undefined && { autoCoffeeEnabled: Boolean(autoCoffeeEnabled) }),
        // ─────────────────────────────────────────────────────────────────────
      },
      select: {
        companyCutoffSettings: true,
        id: true,
        defaultShiftHours: true,
        minimumLunchMinutes: true,
        gracePeriodMinutes: true,
        otBasis: true,
        dailyOtThresholdHours: true,
        weeklyOtThresholdHours: true,
        cutoffOtThresholdHours: true,
        country: true,
        currency: true,
        language: true,
        timeZone: true,
        driverAideThresholdMinutes:    true,
        shiftAssignmentWindowMinutes:  true,
        earlyClockInGraceMinutes:      true,
        earlyClockOutGraceMinutes:     true,
        autoClockOutWarningHours:      true,
        autoClockOutGraceHours:        true,
        autoClockOutNotifyEmails:      true,
        multiApprovalEnabled:          true,
        secondaryApproverId:           true,
        leaveConflictAutoRevert:       true,
        autoBreakBasis:                true,
        autoLunchEnabled:              true,
        autoCoffeeEnabled:             true,
      },
    });

    // Upsert cutoff settings if provided
    if (cutoffSettings?.seedStartDate && cutoffSettings?.durationDays) {
      const duration = Math.max(1, Math.round(Number(cutoffSettings.durationDays)));
      await prisma.companyCutoffSettings.upsert({
        where:  { companyId: req.user.companyId },
        create: {
          companyId:         req.user.companyId,
          seedStartDate:     new Date(cutoffSettings.seedStartDate),
          durationDays:      duration,
          paymentOffsetDays: cutoffSettings.paymentOffsetDays != null
            ? Math.max(0, Number(cutoffSettings.paymentOffsetDays)) : 5,
        },
        update: {
          seedStartDate:     new Date(cutoffSettings.seedStartDate),
          durationDays:      duration,
          ...(cutoffSettings.paymentOffsetDays != null && {
            paymentOffsetDays: Math.max(0, Number(cutoffSettings.paymentOffsetDays)),
          }),
        },
      });
    }

    const cutoff = await prisma.companyCutoffSettings.findUnique({
      where: { companyId: req.user.companyId },
    });

    res.json({
      data: {
        ...updated,
        cutoffSettings: cutoff
          ? {
              seedStartDate:     cutoff.seedStartDate.toISOString().slice(0, 10),
              durationDays:      cutoff.durationDays,
              paymentOffsetDays: cutoff.paymentOffsetDays,
            }
          : null,
      },
    });
  } catch (e) {
    console.error("updateSettings error:", e);
    res.status(400).json({ error: e.message });
  }
};

exports.getCheckSettings = async (req, res) => {
  try {
    const { companyId } = req.user;

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        checkTemplate: true,
        checkPositions: true,
      },
    });

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    // Return saved positions or defaults
    const defaultPositions = {
      date: { x: 480, y: 95 },
      amountWords: { x: 90, y: 135 },
      amountNumber: { x: 455, y: 133 },
      payeeName: { x: 90, y: 170 },
      payeeAddress: { x: 90, y: 185 },
    };

    return res.status(200).json({
      success: true,
      data: {
        checkTemplate: company.checkTemplate || 'default',
        checkPositions: company.checkPositions || defaultPositions,
      },
    });

  } catch (error) {
    console.error("Error fetching check settings:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch check settings",
    });
  }
};

exports.updateCheckSettings = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { checkTemplate, checkPositions } = req.body;

    // Validate positions
    if (checkPositions) {
      const requiredFields = ['date', 'amountWords', 'amountNumber', 'payeeName', 'payeeAddress'];
      for (const field of requiredFields) {
        if (!checkPositions[field] || 
            typeof checkPositions[field].x !== 'number' || 
            typeof checkPositions[field].y !== 'number') {
          return res.status(400).json({
            success: false,
            message: `Invalid position data for ${field}`,
          });
        }
      }
    }

    const updatedCompany = await prisma.company.update({
      where: { id: companyId },
      data: {
        checkTemplate: checkTemplate || 'default',
        checkPositions: checkPositions,
      },
      select: {
        checkTemplate: true,
        checkPositions: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Check settings updated successfully",
      data: updatedCompany,
    });

  } catch (error) {
    console.error("Error updating check settings:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update check settings",
    });
  }
};

exports.getCheckTemplates = async (req, res) => {
  try {
    // Pre-defined templates for common banks
    const templates = {
      default: {
        name: "Default Template",
        positions: {
          date: { x: 480, y: 95, fontSize: 10 },
          amountWords: { x: 90, y: 135, fontSize: 10 },
          amountNumber: { x: 455, y: 133, fontSize: 14 },
          payeeName: { x: 90, y: 170, fontSize: 11 },
          payeeAddress: { x: 90, y: 185, fontSize: 9 },
        },
      },
      bofa: {
        name: "Bank of America",
        positions: {
          date: { x: 480, y: 95, fontSize: 10 },
          amountWords: { x: 90, y: 135, fontSize: 10 },
          amountNumber: { x: 455, y: 133, fontSize: 14 },
          payeeName: { x: 90, y: 170, fontSize: 11 },
          payeeAddress: { x: 90, y: 185, fontSize: 9 },
        },
      },
      chase: {
        name: "Chase Bank",
        positions: {
          date: { x: 490, y: 90 },
          amountWords: { x: 95, y: 130 },
          amountNumber: { x: 460, y: 128 },
          payeeName: { x: 95, y: 165 },
          payeeAddress: { x: 95, y: 180 },
        },
      },
      wells_fargo: {
        name: "Wells Fargo",
        positions: {
          date: { x: 475, y: 92 },
          amountWords: { x: 88, y: 132 },
          amountNumber: { x: 450, y: 130 },
          payeeName: { x: 88, y: 168 },
          payeeAddress: { x: 88, y: 183 },
        },
      },
      quickbooks: {
        name: "QuickBooks Compatible",
        positions: {
          date: { x: 485, y: 98 },
          amountWords: { x: 92, y: 138 },
          amountNumber: { x: 458, y: 136 },
          payeeName: { x: 92, y: 173 },
          payeeAddress: { x: 92, y: 188 },
        },
      },
    };

    return res.status(200).json({
      success: true,
      data: { templates },
    });

  } catch (error) {
    console.error("Error fetching templates:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch templates",
    });
  }
};

exports.generateTestCheckPDF = async (req, res) => {
  try {
    const { companyId } = req.user;

    // Fetch company settings
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        checkTemplate: true,
        checkPositions: true,
      },
    });

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    // ✅ CREATE MOCK PAYROLL DATA
    const mockPayrollRun = {
      payDate: new Date(),
      periodStart: new Date(new Date().setDate(new Date().getDate() - 14)),
      periodEnd: new Date(),
    };

    const mockEmployee = {
      employeeId: 'TEST-001',
      employeeName: 'John Sample Employee',
      position: 'Software Engineer',
      checkNumber: '1001',
      
      // Earnings
      earnings: {
        regularHours: 80,
        regularPay: 2400.00,
        overtimeHours: 5,
        overtimePay: 225.00,
      },
      grossPay: 2625.00,
      
      // Taxes
      taxes: {
        federalTax: 315.00,
        stateTax: 131.25,
        fica: 162.75,
        medicare: 38.06,
        sdi: 28.88,
      },
      totalTaxes: 675.94,
      
      // Deductions
      deductions: {
        healthInsurance: 150.00,
        retirement401k: 131.25,
      },
      totalDeductions: 281.25,
      
      // Net Pay
      netPay: 1667.81,
      
      // Optional employee address for check
      address: '123 Main Street',
      city: 'Anytown',
      state: 'CA',
      postalCode: '12345',
    };

    const mockEarningTypes = [
      { id: 'regularHours', label: 'Regular Hours', code: 'regular_hours' },
      { id: 'overtimeHours', label: 'Overtime Hours', code: 'overtime' },
    ];

    const mockDeductionTypes = [
      { id: 'healthInsurance', label: 'Health Insurance' },
      { id: 'retirement401k', label: '401(k) Contribution' },
    ];

    // ✅ ADD: Mock YTD data
    const mockYTD = {
      grossEarnings: 7875.00,    // 3 pay periods
      regularPay: 7200.00,
      overtimePay: 675.00,
      
      federalTax: 945.00,
      stateTax: 393.75,
      fica: 488.25,
      medicare: 114.18,
      sdi: 86.64,
      totalTaxes: 2027.82,
      
      healthInsurance: 450.00,
      retirement401k: 393.75,
      totalDeductions: 843.75,
      
      netPay: 5003.43,
      
      payPeriodsIncluded: 3,
    };

    // ✅ PASS YTD TO GENERATOR
    const generateCheckPDF = require('@utils/generateCheckPDF');
    const pdfBuffer = await generateCheckPDF(
      mockPayrollRun,
      mockEmployee,
      company,
      mockEarningTypes,
      mockDeductionTypes,
      mockYTD  // ✅ Pass YTD data
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="test_check.pdf"');
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating test check:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate test check',
      error: error.message,
    });
  }
};