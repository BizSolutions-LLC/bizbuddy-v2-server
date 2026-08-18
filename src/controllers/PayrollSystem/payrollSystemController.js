// src/controllers/PayrollSystem/payrollSystemController.js

const { prisma } = require("@config/connection");
const generatePayslipPDF = require('@utils/generatePayslipPDF');
const calculateYTD = require('@utils/calculateYTD');
const { createNotification } = require('@services/notificationService');

// Fallback rates (as decimal fractions) used only if a company has no
// PayrollConfiguration row yet — kept in sync with the DEDUCTION_RATE_DEFAULTS
// percentage defaults in companyInformationController.js / deductionsController.js.
// Federal and State no longer have flat fallback rates — they're
// bracket-based, see DEFAULT_FEDERAL_TAX_BRACKETS / DEFAULT_STATE_TAX_BRACKETS
// in companyInformationController.js.
const DEFAULT_TAX_RATES = {
  ficaRate: 0.062,
  medicareRate: 0.0145,
  sdiRate: 0.011,
};

exports.getEmployeeList = async (req, res) => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(400).json({ 
        success: false,
        message: "Company ID is required." 
      });
    }

    // Fetch all employees with related data
    const users = await prisma.user.findMany({
      where: {
        companyId: companyId,
        // role: {
        //   in: ['employee', 'supervisor', 'admin'] // Exclude superadmin
        // }
      },
      include: {
        profile: {
          select: {
            firstName: true,
            lastName: true,
          }
        },
        employmentDetail: {
          select: {
            jobTitle: true,
            departmentId: true,
          }
        },
        department: {
          select: {
            name: true,
          }
        },
        UserRate: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1, // Get most recent rate
          select: {
            hourlyRate: true,
          }
        }
      },
      orderBy: [
        {
          status: 'asc' // Active first, then inactive, then deleted
        },
        {
          createdAt: 'asc'
        }
      ]
    });

    // Transform data to match frontend expectations
    const employees = users.map(user => {
      const firstName = user.profile?.firstName || '';
      const lastName = user.profile?.lastName || '';
      const fullName = `${firstName} ${lastName}`.trim() || user.username;
      
      return {
        id: user.id,
        name: fullName,
        position: user.employmentDetail?.jobTitle || '',
        status: user.status.charAt(0).toUpperCase() + user.status.slice(1), // Capitalize
        departmentName: user.department?.name || '',
        employeeId: user.employeeId || '',
        hourlyRate: user.UserRate?.[0]?.hourlyRate?.toString() || '0.00',
        email: user.email,
      };
    });

    // Separate by status for better organization
    const activeEmployees = employees.filter(emp => emp.status === 'Active');
    const inactiveEmployees = employees.filter(emp => emp.status === 'Inactive');
    const deletedEmployees = employees.filter(emp => emp.status === 'Deleted');

    // Combine: active first, then inactive, then deleted
    const sortedEmployees = [
      ...activeEmployees,
      ...inactiveEmployees,
      ...deletedEmployees
    ];

    return res.status(200).json({
      success: true,
      message: "Employee list retrieved successfully",
      data: {
        employees: sortedEmployees,
        count: {
          total: sortedEmployees.length,
          active: activeEmployees.length,
          inactive: inactiveEmployees.length,
          deleted: deletedEmployees.length,
        }
      }
    });

  } catch (err) {
    console.error("getEmployeeList error:", err);
    return res.status(500).json({ 
      success: false,
      message: "Internal server error.",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

exports.savePayrollRun = async (req, res) => {
  try {
    const { companyId, userId } = req.user;
    const {
      payDate,
      periodStart,
      periodEnd,
      checkNumberStart,
      employees,
      earningTypes,
      deductionTypes,
      totals,
      hoursData,
    } = req.body;

    // Validation
    if (!payDate || !periodStart || !periodEnd || !employees || employees.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields (payDate, periodStart, periodEnd, employees)' 
      });
    }

    // Check for duplicate period
    const existingRun = await prisma.payrollRun.findFirst({
      where: {
        companyId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        locked: true,
      },
    });

    if (existingRun) {
      return res.status(409).json({
        success: false,
        message: 'Payroll for this period has already been saved and locked.',
        data: { payrollRunId: existingRun.id },
      });
    }

    // Load this company's configured deduction rates (stored as percentages,
    // e.g. 12 for 12%) and convert to the decimal fractions taxRatesUsed
    // expects. Falls back to DEFAULT_TAX_RATES if no config row exists yet.
    const [payrollConfig, federalTaxRates, stateTaxRates] = await Promise.all([
      prisma.payrollConfiguration.findUnique({
        where: { companyId },
        select: {
          ficaRate: true,
          medicareRate: true,
          sdiRate: true,
        },
      }),
      // Federal and State are bracket-based, not flat rates — record
      // whatever brackets are currently enabled for this company at the
      // time of save.
      prisma.federalTaxRate.findMany({
        where: { companyId, enabled: true },
        select: {
          filingStatus: true,
          minAnnualIncome: true,
          maxAnnualIncome: true,
          rate: true,
        },
        orderBy: [{ filingStatus: 'asc' }, { minAnnualIncome: 'asc' }],
      }),
      prisma.stateIncomeTaxRate.findMany({
        where: { companyId, enabled: true },
        select: {
          filingStatus: true,
          minAnnualIncome: true,
          maxAnnualIncome: true,
          rate: true,
        },
        orderBy: [{ filingStatus: 'asc' }, { minAnnualIncome: 'asc' }],
      }),
    ]);

    const taxRatesUsed = {
      federalBrackets: federalTaxRates.map((b) => ({
        filingStatus: b.filingStatus,
        minAnnualIncome: parseFloat(b.minAnnualIncome),
        maxAnnualIncome: b.maxAnnualIncome != null ? parseFloat(b.maxAnnualIncome) : null,
        rate: parseFloat(b.rate) / 100,
      })),
      stateBrackets: stateTaxRates.map((b) => ({
        filingStatus: b.filingStatus,
        minAnnualIncome: parseFloat(b.minAnnualIncome),
        maxAnnualIncome: b.maxAnnualIncome != null ? parseFloat(b.maxAnnualIncome) : null,
        rate: parseFloat(b.rate) / 100,
      })),
      ...(payrollConfig
        ? {
            ficaRate: parseFloat(payrollConfig.ficaRate) / 100,
            medicareRate: parseFloat(payrollConfig.medicareRate) / 100,
            sdiRate: parseFloat(payrollConfig.sdiRate) / 100,
          }
        : DEFAULT_TAX_RATES),
    };

    // Build frozen JSON snapshot
    const payrollSnapshot = {
      payDate,
      periodStart,
      periodEnd,
      checkNumberStart,
      processedAt: new Date().toISOString(),
      processedBy: userId,
      employees: employees.map((emp, index) => ({
        employeeId: emp.id,
        employeeName: emp.name,
        position: emp.position,
        payType: emp.payrollDetails?.payType || 'hourly',
        checkNumber: String(parseInt(checkNumberStart) + index),
        
        // Earnings breakdown
        earnings: emp.calculated.earningsBreakdown,
        grossPay: emp.calculated.grossEarnings,
        
        // Taxes breakdown
        taxes: emp.taxes,
        totalTaxes: emp.taxes.totalTaxes,
        
        // Deductions breakdown
        deductions: emp.calculated.deductionsBreakdown,
        totalDeductions: emp.calculated.totalDeductions,
        
        // Net pay (after taxes and deductions)
        netPay: emp.netPayAfterTaxes,
        
        // Hours data (if available)
        hoursData: hoursData[emp.id] || null,
      })),
      
      // Metadata
      earningTypes: earningTypes.filter(et => et.enabled !== false),
      deductionTypes: deductionTypes.filter(dt => dt.enabled !== false),
      totals,
      
      // Tax rates used (for historical record) — sourced from this
      // company's PayrollConfiguration, not hardcoded.
      taxRatesUsed,
      
      systemVersion: '1.0',
    };

    // Save to database
    const payrollRun = await prisma.payrollRun.create({
      data: {
        companyId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        payDate: new Date(payDate),
        checkNumberStart,
        status: 'finalized',
        locked: true,
        
        totalGross: parseFloat(totals.grossEarnings),
        totalTaxes: parseFloat(totals.totalTaxes),
        totalDeductions: parseFloat(totals.totalDeductions),
        totalNet: parseFloat(totals.netPay),
        
        payrollSnapshot,
        
        savedBy: userId,
        savedAt: new Date(),
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Payroll saved successfully',
      data: {
        payrollRunId: payrollRun.id,
        periodStart,
        periodEnd,
        payDate,
        employeesProcessed: employees.length,
        totalNet: totals.netPay,
      },
    });

  } catch (error) {
    console.error('❌ Error saving payroll:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to save payroll',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

exports.getPayrollRun = async (req, res) => {
  try {
    const { id } = req.params;
    const { companyId } = req.user;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Payroll run ID is required',
      });
    }

    const payrollRun = await prisma.payrollRun.findFirst({
      where: {
        id,
        companyId,
      },
      select: {
        id: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
        checkNumberStart: true,
        status: true,
        locked: true,
        totalGross: true,
        totalTaxes: true,
        totalDeductions: true,
        totalNet: true,
        payrollSnapshot: true,
        savedBy: true,
        savedAt: true,
        createdAt: true,
      },
    });

    if (!payrollRun) {
      return res.status(404).json({
        success: false,
        message: 'Payroll run not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Payroll run retrieved successfully',
      data: payrollRun,
    });

  } catch (error) {
    console.error('Error fetching payroll run:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payroll run',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

exports.listPayrollRuns = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { status, limit = 20, offset = 0 } = req.query;

    const where = { companyId };
    if (status) {
      where.status = status;
    }

    const payrollRuns = await prisma.payrollRun.findMany({
      where,
      select: {
        id: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
        status: true,
        locked: true,
        totalGross: true,
        totalNet: true,
        savedAt: true,
      },
      orderBy: {
        periodEnd: 'desc',
      },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    const total = await prisma.payrollRun.count({ where });

    return res.status(200).json({
      success: true,
      message: 'Payroll runs retrieved successfully',
      data: {
        payrollRuns,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      },
    });

  } catch (error) {
    console.error('Error listing payroll runs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to list payroll runs',
    });
  }
};

exports.getPayrollReports = async (req, res) => {
  try {
    const { companyId } = req.user;
    const { from, to, year, sortBy = 'payDate' } = req.query;

    // Build date range filter
    const where = { 
      companyId,
      locked: true, // Only show saved/finalized payrolls
    };

    if (from && to && year) {
      const fromDate = new Date(`${year}-${from}`);
      const toDate = new Date(`${year}-${to}`);
      
      where.periodStart = { gte: fromDate };
      where.periodEnd = { lte: toDate };
    }

    // Determine sort order
    let orderBy = {};
    switch (sortBy) {
      case 'Pay Date':
        orderBy = { payDate: 'desc' };
        break;
      case 'Employee Name':
        orderBy = { createdAt: 'desc' }; // Fallback
        break;
      case 'Amount':
        orderBy = { totalNet: 'desc' };
        break;
      default:
        orderBy = { payDate: 'desc' };
    }

    const payrollRuns = await prisma.payrollRun.findMany({
      where,
      select: {
        id: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
        checkNumberStart: true,
        totalGross: true,
        totalTaxes: true,
        totalDeductions: true,
        totalNet: true,
        payrollSnapshot: true,
        savedAt: true,
      },
      orderBy,
    });

    // Transform data for frontend
    const reports = payrollRuns.map(run => ({
      id: run.id,
      payDate: run.payDate,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      checkNumberStart: run.checkNumberStart,
      totalGross: parseFloat(run.totalGross),
      totalTaxes: parseFloat(run.totalTaxes),
      totalDeductions: parseFloat(run.totalDeductions),
      totalNet: parseFloat(run.totalNet),
      employeeCount: run.payrollSnapshot?.employees?.length || 0,
      savedAt: run.savedAt,
      employees: run.payrollSnapshot?.employees || [],
    }));

    return res.status(200).json({
      success: true,
      message: 'Payroll reports retrieved successfully',
      data: {
        reports,
        count: reports.length,
      },
    });

  } catch (error) {
    console.error('Error fetching payroll reports:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payroll reports',
    });
  }
};

exports.getUnviewedReportsCount = async (req, res) => {
  try {
    const { companyId, userId } = req.user;

    // Count payrolls saved in last 7 days (adjust as needed)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const count = await prisma.payrollRun.count({
      where: {
        companyId,
        locked: true,
        savedAt: {
          gte: sevenDaysAgo,
        },
      },
    });

    return res.status(200).json({
      success: true,
      data: { count },
    });

  } catch (error) {
    console.error('Error counting unviewed reports:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to count reports',
    });
  }
};

exports.generatePayslipPDF = async (req, res) => {
  try {
    const { payrollRunId, employeeId } = req.params; 
    const { companyId } = req.user;

    const payrollRun = await prisma.payrollRun.findFirst({
      where: { id: payrollRunId, companyId },
      select: {
        payrollSnapshot: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!payrollRun) {
      return res.status(404).json({ success: false, message: 'Payroll run not found' });
    }

    const employee = payrollRun.payrollSnapshot.employees.find(e => e.employeeId === employeeId); 
    
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, addressLine1: true, city: true, state: true, postalCode: true },
    });

    const earningTypes = payrollRun.payrollSnapshot.earningTypes || [];
    const deductionTypes = payrollRun.payrollSnapshot.deductionTypes || [];

    // ✅ NEW: Calculate YTD
    const ytd = await calculateYTD(employeeId, companyId, payrollRun.periodEnd);

    const pdfBuffer = await generatePayslipPDF(
      payrollRun, 
      employee, 
      company, 
      earningTypes, 
      deductionTypes,
      ytd // ✅ Pass YTD data
    );

    const cleanName = employee.employeeName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const startDate = new Date(payrollRun.periodStart).toISOString().split('T')[0];
    const endDate = new Date(payrollRun.periodEnd).toISOString().split('T')[0];
    const filename = `Payslip_${cleanName}_${startDate}_to_${endDate}.pdf`;

    // Notify the employee that their payslip is available
    try {
      const empUser = await prisma.user.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      await createNotification({
        userId: employeeId,
        companyId,
        departmentId: empUser?.departmentId || null,
        notificationCode: 'PAYSLIP_GENERATED',
        title: 'Payslip Available',
        message: `Your payslip for ${startDate} - ${endDate} is now available.`,
        payload: { payrollRunId, periodStart: payrollRun.periodStart, periodEnd: payrollRun.periodEnd },
      });
    } catch (notifError) {
      console.error('❌ Failed to send payslip notification:', notifError);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('❌ Error generating payslip:', error);
    res.status(500).json({ success: false, message: 'Failed to generate payslip' });
  }
};

exports.getMyPayslips = async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { companyId } = req.user;

    const payrollRuns = await prisma.payrollRun.findMany({
      where: {
        companyId,
        locked: true,
      },
      select: {
        id: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
        payrollSnapshot: true,
      },
      orderBy: {
        periodEnd: 'desc',
      },
    });


    const myPayslips = payrollRuns
      .map(run => {
        const employee = run.payrollSnapshot.employees.find(e => {
          return e.employeeId === userId;
        });
        
        if (!employee) {
          console.log('❌ Employee not found in this run');
          return null;
        }

        return {
          id: run.id,
          payrollRunId: run.id,
          payDate: run.payDate,
          periodStart: run.periodStart,
          checkNumber: employee.checkNumber,
          periodEnd: run.periodEnd,
          grossPay: employee.grossPay,
          taxes: employee.totalTaxes,
          deductions: employee.totalDeductions,
          netPay: employee.netPay,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      data: { payslips: myPayslips },
    });

  } catch (error) {
    console.error('❌ Error fetching payslips:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payslips',
    });
  }
};

exports.getMyPayslipPDF = async (req, res) => {
  try {
    const { payrollRunId } = req.params;
    const userId = req.user.userId || req.user.id;
    const { companyId } = req.user;

    const payrollRun = await prisma.payrollRun.findFirst({
      where: { id: payrollRunId, companyId },
      select: {
        payrollSnapshot: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!payrollRun) {
      return res.status(404).json({ success: false, message: 'Payroll run not found' });
    }

    const employee = payrollRun.payrollSnapshot.employees.find(e => e.employeeId === userId);
    
    if (!employee) {
      return res.status(404).json({ success: false, message: 'You are not in this payroll run' });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, addressLine1: true },
    });

    const earningTypes = payrollRun.payrollSnapshot.earningTypes || [];
    const deductionTypes = payrollRun.payrollSnapshot.deductionTypes || [];

    // ✅ NEW: Calculate YTD
    const ytd = await calculateYTD(userId, companyId, payrollRun.periodEnd);

    const pdfBuffer = await generatePayslipPDF(
      payrollRun, 
      employee, 
      company, 
      earningTypes, 
      deductionTypes,
      ytd // ✅ Pass YTD data
    );

    const cleanName = employee.employeeName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const startDate = new Date(payrollRun.periodStart).toISOString().split('T')[0];
    const endDate = new Date(payrollRun.periodEnd).toISOString().split('T')[0];
    const filename = `Payslip_${cleanName}_${startDate}_to_${endDate}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('❌ Error generating payslip:', error);
    res.status(500).json({ success: false, message: 'Failed to generate payslip' });
  }
};

exports.getSuggestedCheckNumber = async (req, res) => {
  try {
    const { companyId } = req.user;

    // Get the most recent finalized payroll
    const lastPayroll = await prisma.payrollRun.findFirst({
      where: {
        companyId,
        locked: true,
      },
      select: {
        checkNumberStart: true,
        payrollSnapshot: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!lastPayroll) {
      // No previous payroll, suggest starting at 1001
      return res.status(200).json({
        success: true,
        data: { suggestedCheckNumber: '1001' },
      });
    }

    // Calculate next check number
    const lastCheckStart = parseInt(lastPayroll.checkNumberStart) || 1000;
    const employeeCount = lastPayroll.payrollSnapshot?.employees?.length || 0;
    const nextCheckNumber = lastCheckStart + employeeCount;

    return res.status(200).json({
      success: true,
      data: { 
        suggestedCheckNumber: nextCheckNumber.toString(),
        lastCheckStart: lastCheckStart.toString(),
        lastEmployeeCount: employeeCount,
      },
    });

  } catch (error) {
    console.error('Error getting suggested check number:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get suggested check number',
    });
  }
};

exports.generateCheckPDF = async (req, res) => {
  try {
    const { payrollRunId, employeeId } = req.params;
    const { companyId } = req.user;

    const payrollRun = await prisma.payrollRun.findFirst({
      where: { id: payrollRunId, companyId },
      select: {
        payrollSnapshot: true,
        payDate: true,
        periodStart: true,
        periodEnd: true,
      },
    });

    if (!payrollRun) {
      return res.status(404).json({ success: false, message: 'Payroll run not found' });
    }

    const employee = payrollRun.payrollSnapshot.employees.find(e => e.employeeId === employeeId);
    
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    // ✅ FETCH COMPANY WITH CHECK POSITIONS
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

    const earningTypes = payrollRun.payrollSnapshot.earningTypes || [];
    const deductionTypes = payrollRun.payrollSnapshot.deductionTypes || [];

    // ✅ NEW: Calculate YTD
    const ytd = await calculateYTD(employeeId, companyId, payrollRun.periodEnd);

    const generateCheckPDF = require('@utils/generateCheckPDF');
    const pdfBuffer = await generateCheckPDF(
      payrollRun, 
      employee, 
      company, 
      earningTypes, 
      deductionTypes,
      ytd // ✅ Pass YTD data
    );

    const cleanName = employee.employeeName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const filename = `Check_${employee.checkNumber}_${cleanName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('❌ Error generating check:', error);
    res.status(500).json({ success: false, message: 'Failed to generate check' });
  }
};