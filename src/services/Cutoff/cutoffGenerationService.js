// services/Cutoff/cutoffGenerationService.js
// ✅ UPDATED WITH HISTORICAL PERIOD SUPPORT

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/**
 * ✅ NEW: Generate periods between specific dates (for historical backfill)
 *
 * anchorStartDate is the department's configured DepartmentCutoffSettings.startDate.
 * The requested startDate/endDate only bound the output range — the actual period
 * boundaries are derived by walking forward from anchorStartDate, so historical
 * generation stays on the same cadence as the normal forward-generation path
 * instead of anchoring to whatever raw date the caller passed in.
 */
function generatePeriodsBetweenDates(startDate, endDate, frequency, paymentOffset, anchorStartDate) {
  const periods = [];
  const targetStart = new Date(startDate);
  const targetEnd = new Date(endDate);

  // Walk forward from the configured anchor to the first period that covers
  // (or starts on/after) the requested range start.
  let currentStart = new Date(anchorStartDate);
  let alignIterationCount = 0;
  const maxAlignIterations = 500;
  while (alignIterationCount < maxAlignIterations) {
    const periodEnd = calculatePeriodEnd(currentStart, frequency);
    if (periodEnd >= targetStart) break;
    currentStart = new Date(periodEnd);
    currentStart.setDate(currentStart.getDate() + 1);
    alignIterationCount++;
  }

  let iterationCount = 0;
  const maxIterations = 200; // Increased for historical data

  while (currentStart <= targetEnd && iterationCount < maxIterations) {
    const periodEnd = calculatePeriodEnd(currentStart, frequency);
    
    // Stop if we've passed the target end date
    if (periodEnd > targetEnd) {
      break;
    }
    
    const paymentDate = new Date(periodEnd);
    paymentDate.setDate(paymentDate.getDate() + paymentOffset);
    
    periods.push({
      periodStart: new Date(currentStart),
      periodEnd: periodEnd,
      paymentDate: paymentDate
    });
    
    // Next period starts the day after current ends
    currentStart = new Date(periodEnd);
    currentStart.setDate(currentStart.getDate() + 1);
    iterationCount++;
  }
  
  return periods;
}

/**
 * ✅ UPDATED: Generate period dates with optional historical support
 */
function generatePeriodDates(startDate, frequency, paymentOffset, months, includeHistorical = false) {
  const periods = [];
  let currentStart = new Date(startDate);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + months);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let iterationCount = 0;
  const maxIterations = 200; // Increased for historical data
  
  while (currentStart < endDate && iterationCount < maxIterations) {
    const periodEnd = calculatePeriodEnd(currentStart, frequency);
    const paymentDate = new Date(periodEnd);
    paymentDate.setDate(paymentDate.getDate() + paymentOffset);
    
    // ✅ FIXED: Allow past periods if includeHistorical is true
    const shouldInclude = includeHistorical ? true : periodEnd >= today;
    
    if (shouldInclude) {
      periods.push({
        periodStart: new Date(currentStart),
        periodEnd: periodEnd,
        paymentDate: paymentDate
      });
    }
    
    currentStart = new Date(periodEnd);
    currentStart.setDate(currentStart.getDate() + 1);
    iterationCount++;
  }
  
  return periods;
}

/**
 * Helper: Calculate period end date based on frequency
 */
function calculatePeriodEnd(startDate, frequency) {
  const end = new Date(startDate);
  
  switch (frequency) {
    case 'bi-weekly':
      // 14 days (2 weeks)
      end.setDate(end.getDate() + 13); // 13 days after start = 14 days total
      break;
      
    case 'bi-monthly':
      // Twice a month: 1-15, 16-end of month
      const dayOfMonth = startDate.getDate();
      
      if (dayOfMonth === 1) {
        // Period 1-15
        end.setDate(15);
      } else if (dayOfMonth === 16) {
        // Period 16-end of month
        end.setMonth(end.getMonth() + 1, 0); // Last day of current month
      } else {
        // Handle edge cases - default to 15 days
        end.setDate(end.getDate() + 14);
      }
      break;
      
    case 'monthly':
      // One month from start, ending on last day before next period
      end.setMonth(end.getMonth() + 1);
      end.setDate(end.getDate() - 1); // Day before next month starts
      break;
      
    default:
      throw new Error(`Invalid frequency: ${frequency}`);
  }
  
  return end;
}

/**
 * ✅ UPDATED: Generate cutoff periods with historical support
 */
const generateCutoffPeriods = async (req, res) => {
  try {
    const { companyId, id: userId } = req.user;
    const { 
      departmentId, 
      months = 3,
      includeHistorical = false,  // ✅ NEW PARAMETER
      fromDate = null,            // ✅ NEW: Generate from specific date
      toDate = null               // ✅ NEW: Generate to specific date
    } = req.body;
    
    // Get department settings
    const settings = await prisma.departmentCutoffSettings.findFirst({
      where: { companyId, departmentId: departmentId ?? null },
      include: { department: true }
    });

    if (!settings) {
      return res.status(404).json({ 
        success: false, 
        message: 'Department cutoff settings not found. Please configure settings first.' 
      });
    }

    if (!settings.isActive) {
      return res.status(400).json({ 
        success: false, 
        message: 'Department cutoff settings are inactive. Please activate first.' 
      });
    }
    
    let periods;
    
    // ✅ Option 1: Generate between specific dates (for historical backfill)
    if (fromDate && toDate) {
      console.log(`[📅 Generating historical periods] ${settings.department.name}: ${fromDate} → ${toDate}`);
      periods = generatePeriodsBetweenDates(
        new Date(fromDate),
        new Date(toDate),
        settings.frequency,
        settings.paymentOffsetDays,
        settings.startDate
      );
    }
    // ✅ Option 2: Generate X months with historical option
    else {
      console.log(`[📅 Generating ${months} months] ${settings.department.name} (includeHistorical: ${includeHistorical})`);
      periods = generatePeriodDates(
        settings.startDate,
        settings.frequency,
        settings.paymentOffsetDays,
        months,
        includeHistorical
      );
    }
    
    if (periods.length === 0) {
      return res.json({
        success: true,
        data: { 
          created: 0, 
          skipped: 0,
          departmentName: settings.department.name 
        },
        message: 'No periods to generate for the specified date range'
      });
    }
    
    // Check for existing periods (avoid duplicates)
    const existingPeriods = await prisma.cutoffPeriod.findMany({
      where: {
        companyId,
        departmentId,
        periodStart: { 
          in: periods.map(p => new Date(p.periodStart)) 
        }
      },
      select: { periodStart: true }
    });
    
    const existingStarts = new Set(
      existingPeriods.map(p => p.periodStart.toISOString().split('T')[0])
    );
    
    // Filter out existing periods
    const newPeriods = periods.filter(p => {
      const dateStr = new Date(p.periodStart).toISOString().split('T')[0];
      return !existingStarts.has(dateStr);
    });
    
    if (newPeriods.length === 0) {
      return res.json({
        success: true,
        data: { 
          created: 0, 
          skipped: periods.length,
          departmentName: settings.department.name 
        },
        message: `All ${periods.length} periods already exist for ${settings.department.name}`
      });
    }
    
    // ✅ Auto-set status based on date (past = processed, current/future = open)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const created = await prisma.cutoffPeriod.createMany({
      data: newPeriods.map(period => ({
        id: `cutoff_${departmentId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        companyId,
        departmentId,
        periodStart: new Date(period.periodStart),
        periodEnd: new Date(period.periodEnd),
        paymentDate: new Date(period.paymentDate),
        frequency: settings.frequency,
        status: new Date(period.periodEnd) < today ? 'processed' : 'open',  // ✅ Auto-mark past periods
        isAutoGenerated: true,
        createdBy: userId
      }))
    });
    
    // ✅ Count historical vs future
    const historicalCount = newPeriods.filter(p => new Date(p.periodEnd) < today).length;
    const futureCount = newPeriods.filter(p => new Date(p.periodEnd) >= today).length;
    
    console.log(`[✅ Generated ${created.count} periods] Historical: ${historicalCount}, Future: ${futureCount}`);
    
    res.json({
      success: true,
      data: { 
        created: created.count,
        skipped: existingPeriods.length,
        historical: historicalCount,
        future: futureCount,
        departmentName: settings.department.name,
        frequency: settings.frequency
      },
      message: `Generated ${created.count} cutoff periods for ${settings.department.name}${historicalCount > 0 ? ` (${historicalCount} historical)` : ''}`
    });
  } catch (error) {
    console.error('❌ Error generating cutoff periods:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate cutoff periods',
      error: error.message 
    });
  }
};

/**
 * ✅ UPDATED: Bulk generate for all departments with historical support
 */
const generateAllDepartmentCutoffs = async (req, res) => {
  try {
    const { companyId, id: userId } = req.user;
    const { 
      months = 3,
      includeHistorical = false,
      fromDate = null,
      toDate = null
    } = req.body;
    
    // Get all active department settings
    const allSettings = await prisma.departmentCutoffSettings.findMany({
      where: { 
        companyId,
        isActive: true 
      },
      include: {
        department: { select: { name: true } }
      }
    });

    if (allSettings.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No active department cutoff settings found' 
      });
    }

    const results = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Generate for each department
    for (const settings of allSettings) {
      try {
        let periods;
        
        if (fromDate && toDate) {
          periods = generatePeriodsBetweenDates(
            new Date(fromDate),
            new Date(toDate),
            settings.frequency,
            settings.paymentOffsetDays,
            settings.startDate
          );
        } else {
          periods = generatePeriodDates(
            settings.startDate,
            settings.frequency,
            settings.paymentOffsetDays,
            months,
            includeHistorical
          );
        }

        // Check existing
        const existingPeriods = await prisma.cutoffPeriod.findMany({
          where: {
            companyId,
            departmentId: settings.departmentId,
            periodStart: { in: periods.map(p => new Date(p.periodStart)) }
          },
          select: { periodStart: true }
        });

        const existingStarts = new Set(
          existingPeriods.map(p => p.periodStart.toISOString().split('T')[0])
        );

        const newPeriods = periods.filter(p => {
          const dateStr = new Date(p.periodStart).toISOString().split('T')[0];
          return !existingStarts.has(dateStr);
        });

        if (newPeriods.length > 0) {
          const created = await prisma.cutoffPeriod.createMany({
            data: newPeriods.map(period => ({
              id: `cutoff_${settings.departmentId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              companyId,
              departmentId: settings.departmentId,
              periodStart: new Date(period.periodStart),
              periodEnd: new Date(period.periodEnd),
              paymentDate: new Date(period.paymentDate),
              frequency: settings.frequency,
              status: new Date(period.periodEnd) < today ? 'processed' : 'open',
              isAutoGenerated: true,
              createdBy: userId
            }))
          });

          const historicalCount = newPeriods.filter(p => new Date(p.periodEnd) < today).length;

          results.push({
            department: settings.department.name,
            created: created.count,
            skipped: existingPeriods.length,
            historical: historicalCount,
            future: created.count - historicalCount
          });
        } else {
          results.push({
            department: settings.department.name,
            created: 0,
            skipped: periods.length
          });
        }
      } catch (error) {
        console.error(`Error generating for ${settings.department.name}:`, error);
        results.push({
          department: settings.department.name,
          error: error.message
        });
      }
    }

    const totalCreated = results.reduce((sum, r) => sum + (r.created || 0), 0);
    const totalHistorical = results.reduce((sum, r) => sum + (r.historical || 0), 0);

    res.json({
      success: true,
      data: {
        totalCreated,
        totalHistorical,
        departments: results.length,
        details: results
      },
      message: `Generated ${totalCreated} cutoff periods across ${results.length} departments${totalHistorical > 0 ? ` (${totalHistorical} historical)` : ''}`
    });
  } catch (error) {
    console.error('Error generating all department cutoffs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate cutoffs for all departments',
      error: error.message 
    });
  }
};

module.exports = {
  generateCutoffPeriods,
  generateAllDepartmentCutoffs,
  generatePeriodDates,
  generatePeriodsBetweenDates
};