const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

function toDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  return d;
}

function clampPeriod(start, end) {
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  if (s > e) throw new Error("periodStart must be <= periodEnd");
  return { s, e };
}

function hoursBetween(a, b) {
  const ms = Math.max(0, b.getTime() - a.getTime());
  return ms / (1000 * 60 * 60);
}

async function getActivePaySchedule(companyId) {
  return prisma.paySchedule.findFirst({
    where: { companyId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

async function getLatestUserRate(userId) {
  return prisma.userRate.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

async function getJurisdictionForUser(userId, companyId) {
  const [company, emp] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { payrollCountry: true, stateCode: true },
    }),
    prisma.employmentDetail.findUnique({
      where: { userId },
      select: { workState: true },
    }),
  ]);
  const country = company?.payrollCountry || "OTHER";
  const state = emp?.workState || company?.stateCode || null;
  if (country === "PH") return { country: "PH", state: null, key: "PH" };
  if (country === "US") {
    if (state === "CA") return { country: "US", state: "CA", key: "US-CA" };
    return { country: "US", state: state || null, key: "US-OTHER" };
  }
  return { country: "OTHER", state: null, key: "OTHER" };
}

async function pickContribution(country, agency, frequency, stateCode, base) {
  const today = new Date();
  const list = await prisma.contributionBracket.findMany({
    where: {
      country,
      agency,
      frequency,
      stateCode,
      effectiveFrom: { lte: today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    },
    orderBy: { minSalaryBase: "asc" },
  });
  for (const b of list) {
    const min = Number(b.minSalaryBase);
    const max = b.maxSalaryBase != null ? Number(b.maxSalaryBase) : null;
    const val = Number(base);
    if (val < min) continue;
    if (max != null && val > max) continue;
    return b;
  }
  return null;
}

async function computeWithholding(
  country,
  frequency,
  authority,
  stateCode,
  taxable
) {
  const today = new Date();
  const brackets = await prisma.withholdingTaxBracket.findMany({
    where: {
      country,
      frequency,
      authority,
      stateCode: authority === "state" ? stateCode : null,
      effectiveFrom: { lte: today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
    },
    orderBy: { minBase: "asc" },
  });

  const t = Number(taxable);
  let tax = 0;
  for (const b of brackets) {
    const min = Number(b.minBase);
    const max = b.maxBase != null ? Number(b.maxBase) : null;
    if (t < min) break;
    if (max != null && t > max) continue;
    const excess = Math.max(0, t - min);
    tax = Number(b.baseTax) + excess * Number(b.excessRate || 0);
    break;
  }
  return tax;
}

/**
 * Core calculation for a single user inside a run
 */
async function computeEntryForUser({ run, userId }) {
  const company = await prisma.company.findUnique({
    where: { id: run.companyId },
  });
  if (!company) throw new Error("Company not found");

  const defaultDailyHours = company.defaultShiftHours
    ? Number(company.defaultShiftHours)
    : 8;

  const rateRow = await getLatestUserRate(userId);
  if (!rateRow) {
    return { skip: true, reason: "No hourly rate set", userId };
  }
  const hourlyRate = Number(rateRow.hourlyRate || 0);

  const { country, state } = await getJurisdictionForUser(
    userId,
    run.companyId
  );

  const { s, e } = clampPeriod(run.periodStart, run.periodEnd);

  const timeLogs = await prisma.timeLog.findMany({
    where: {
      userId,
      timeIn: { lte: e },
      OR: [{ timeOut: null }, { timeOut: { gte: s } }],
      status: true,
    },
    select: {
      timeIn: true,
      timeOut: true,
      coffeeBreaks: true,
      lunchBreak: true,
    },
  });

  let totalWorkHours = 0;

  for (const lg of timeLogs) {
    const ti = new Date(lg.timeIn);
    const to = lg.timeOut ? new Date(lg.timeOut) : e;
    const start = ti < s ? s : ti;
    const end = to > e ? e : to;
    if (end <= start) continue;

    let hours = hoursBetween(start, end);

    if (
      lg.lunchBreak &&
      typeof lg.lunchBreak === "object" &&
      lg.lunchBreak.minutes
    ) {
      hours -= Number(lg.lunchBreak.minutes) / 60;
    }

    if (Array.isArray(lg.coffeeBreaks)) {
      const mins = lg.coffeeBreaks.reduce(
        (acc, b) => acc + (b?.minutes || 0),
        0
      );
      hours -= mins / 60;
    }

    totalWorkHours += Math.max(0, hours);
  }

  const overtimeRows = await prisma.overtime.findMany({
    where: {
      requesterId: userId,
      status: "approved",
      createdAt: { gte: s, lte: e },
    },
    select: { requestedHours: true },
  });

  const overtimeHours = overtimeRows.reduce(
    (acc, r) => acc + Number(r.requestedHours || 0),
    0
  );

  const leaves = await prisma.leave.findMany({
    where: {
      userId,
      status: "approved",
      OR: [{ startDate: { lte: e }, endDate: { gte: s } }],
    },
    select: { startDate: true, endDate: true, leaveType: true },
  });

  let leavePaidHours = 0;
  for (const lv of leaves) {
    const st = new Date(lv.startDate);
    const en = new Date(lv.endDate);
    const start = st > s ? st : s;
    const end = en < e ? en : e;
    if (end < start) continue;
    const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
    leavePaidHours += days * defaultDailyHours;
  }

  const holidays = await prisma.holiday.findMany({
    where: { companyId: run.companyId, date: { gte: s, lte: e } },
    select: { type: true },
  });

  const holidayMultiplier = (t) => {
    if (t === "double") return 2.0;
    if (t === "special") return 0.3;
    return 1.0;
    // You can tune this to your exact policy
  };

  const holidayPay = holidays.reduce(
    (acc, h) =>
      acc +
      hourlyRate * defaultDailyHours * holidayMultiplier(h.type || "regular"),
    0
  );

  const regularHours = Math.max(0, totalWorkHours - overtimeHours);
  const basicPay = hourlyRate * regularHours;
  const overtimePay = hourlyRate * overtimeHours * 1.25;
  const nightDiffPay = 0;
  const leavePay = hourlyRate * leavePaidHours;
  const allowances = 0;
  const otherEarnings = 0;
  const lateUndertime = 0;
  const absences = 0;
  const otherDeductions = 0;

  const gross =
    basicPay +
    overtimePay +
    nightDiffPay +
    holidayPay +
    leavePay +
    allowances +
    otherEarnings;

  const monthlyBaseEstimate = hourlyRate * defaultDailyHours * 22;

  let sssEmployee = 0;
  let philHealthEmp = 0;
  let pagIbigEmp = 0;

  let ficaSS = 0;
  let ficaMed = 0;
  let caSdi = 0;

  if (country === "PH") {
    const sss = await pickContribution(
      "PH",
      "SSS",
      "monthly",
      null,
      monthlyBaseEstimate
    );
    const phic = await pickContribution(
      "PH",
      "PhilHealth",
      "monthly",
      null,
      monthlyBaseEstimate
    );
    const hdmf = await pickContribution(
      "PH",
      "PagIBIG",
      "monthly",
      null,
      monthlyBaseEstimate
    );

    sssEmployee = sss
      ? sss.employeeFixed != null
        ? Number(sss.employeeFixed)
        : monthlyBaseEstimate * Number(sss.employeeRate || 0)
      : 0;

    philHealthEmp = phic
      ? phic.employeeFixed != null
        ? Number(phic.employeeFixed)
        : monthlyBaseEstimate * Number(phic.employeeRate || 0)
      : 0;

    pagIbigEmp = hdmf
      ? hdmf.employeeFixed != null
        ? Number(hdmf.employeeFixed)
        : monthlyBaseEstimate * Number(hdmf.employeeRate || 0)
      : 0;
  }

  if (country === "US") {
    const ss = await pickContribution(
      "US",
      "SocialSecurity",
      "monthly",
      null,
      monthlyBaseEstimate
    );
    const med = await pickContribution(
      "US",
      "Medicare",
      "monthly",
      null,
      monthlyBaseEstimate
    );
    ficaSS = ss
      ? ss.employeeFixed != null
        ? Number(ss.employeeFixed)
        : monthlyBaseEstimate * Number(ss.employeeRate || 0)
      : 0;
    ficaMed = med
      ? med.employeeFixed != null
        ? Number(med.employeeFixed)
        : monthlyBaseEstimate * Number(med.employeeRate || 0)
      : 0;

    if (state === "CA") {
      const sdi = await pickContribution(
        "US",
        "CA_SDI",
        "monthly",
        "CA",
        monthlyBaseEstimate
      );
      caSdi = sdi
        ? sdi.employeeFixed != null
          ? Number(sdi.employeeFixed)
          : monthlyBaseEstimate * Number(sdi.employeeRate || 0)
        : 0;
    }
  }

  let employeeContribTotal = 0;
  if (country === "PH") {
    employeeContribTotal = sssEmployee + philHealthEmp + pagIbigEmp;
  } else if (country === "US") {
    employeeContribTotal = ficaSS + ficaMed + caSdi;
  }

  let taxable = Math.max(0, gross - employeeContribTotal);

  let whtFederal = 0;
  let whtState = 0;

  if (country === "PH") {
    whtFederal = await computeWithholding(
      "PH",
      "semimonthly",
      "federal",
      null,
      taxable
    );
  } else if (country === "US") {
    whtFederal = await computeWithholding(
      "US",
      "semimonthly",
      "federal",
      null,
      taxable
    );
    if (state === "CA") {
      whtState = await computeWithholding(
        "US",
        "semimonthly",
        "state",
        "CA",
        taxable
      );
    }
  }

  const withholdingTax = whtFederal + whtState;

  const net =
    gross -
    lateUndertime -
    absences -
    employeeContribTotal -
    withholdingTax -
    otherDeductions;

  const dataForEntry = {
    runId: run.id,
    userId,
    basicPay: Number(basicPay.toFixed(2)),
    overtimePay: Number(overtimePay.toFixed(2)),
    nightDiffPay: Number(nightDiffPay.toFixed(2)),
    holidayPay: Number(holidayPay.toFixed(2)),
    leavePay: Number(leavePay.toFixed(2)),
    allowances: Number(allowances.toFixed(2)),
    otherEarnings: Number(otherEarnings.toFixed(2)),
    lateUndertime: Number(lateUndertime.toFixed(2)),
    absences: Number(absences.toFixed(2)),
    otherDeductions: Number(otherDeductions.toFixed(2)),
    sssEmployee: Number(sssEmployee.toFixed(2)),
    philHealthEmp: Number(philHealthEmp.toFixed(2)),
    pagIbigEmp: Number(pagIbigEmp.toFixed(2)),
    withholdingTax: Number(withholdingTax.toFixed(2)),
    grossPay: Number(gross.toFixed(2)),
    netPay: Number(net.toFixed(2)),
  };

  const upserted = await prisma.payrollEntry.upsert({
    where: {
      runId_userId: { runId: run.id, userId },
    },
    create: dataForEntry,
    update: dataForEntry,
  });

  await prisma.payrollLine.deleteMany({ where: { entryId: upserted.id } });

  const lines = [
    {
      type: "earning",
      code: "BASIC",
      label: "Basic Pay",
      amount: dataForEntry.basicPay,
    },
    {
      type: "earning",
      code: "OT",
      label: "Overtime Pay",
      amount: dataForEntry.overtimePay,
    },
    {
      type: "earning",
      code: "ND",
      label: "Night Differential",
      amount: dataForEntry.nightDiffPay,
    },
    {
      type: "earning",
      code: "HOL",
      label: "Holiday Pay",
      amount: dataForEntry.holidayPay,
    },
    {
      type: "earning",
      code: "LEAVE",
      label: "Leave Pay",
      amount: dataForEntry.leavePay,
    },
    {
      type: "earning",
      code: "ALLOW",
      label: "Allowances",
      amount: dataForEntry.allowances,
    },
    {
      type: "earning",
      code: "OTH_E",
      label: "Other Earnings",
      amount: dataForEntry.otherEarnings,
    },

    {
      type: "deduction",
      code: "LATE_UT",
      label: "Late/Undertime",
      amount: dataForEntry.lateUndertime,
    },
    {
      type: "deduction",
      code: "ABS",
      label: "Absences",
      amount: dataForEntry.absences,
    },
    {
      type: "deduction",
      code: "OTH_D",
      label: "Other Deductions",
      amount: dataForEntry.otherDeductions,
    },

    {
      type: "contribution",
      code: "SSS",
      label: "SSS (Employee)",
      amount: dataForEntry.sssEmployee,
    },
    {
      type: "contribution",
      code: "PHIC",
      label: "PhilHealth (Employee)",
      amount: dataForEntry.philHealthEmp,
    },
    {
      type: "contribution",
      code: "HDMF",
      label: "Pag-IBIG (Employee)",
      amount: dataForEntry.pagIbigEmp,
    },
    {
      type: "contribution",
      code: "FICA_SS",
      label: "Social Security",
      amount: Number(ficaSS.toFixed(2)),
    },
    {
      type: "contribution",
      code: "FICA_MED",
      label: "Medicare",
      amount: Number(ficaMed.toFixed(2)),
    },
    {
      type: "contribution",
      code: "CA_SDI",
      label: "CA SDI",
      amount: Number(caSdi.toFixed(2)),
    },

    {
      type: "tax",
      code: "WHT_FED",
      label: "Withholding Federal",
      amount: Number(whtFederal.toFixed(2)),
    },
    {
      type: "tax",
      code: "WHT_STATE",
      label: "Withholding State",
      amount: Number(whtState.toFixed(2)),
    },
  ];

  if (lines.length) {
    await prisma.payrollLine.createMany({
      data: lines.map((l) => ({
        entryId: upserted.id,
        type: l.type,
        code: l.code,
        label: l.label,
        amount: l.amount,
      })),
    });
  }

  return upserted;
}

/**
 * Controller functions
 */

const getMyPayrollRecords = async (req, res) => {
  try {
    const entries = await prisma.payrollEntry.findMany({
      where: { userId: req.user.id },
      include: { run: true },
      orderBy: [{ createdAt: "desc" }],
    });

    return res.status(200).json({
      message: "Payroll entries retrieved successfully.",
      data: entries,
    });
  } catch (error) {
    console.error("Error in getMyPayrollRecords:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getAllPayrollRecords = async (req, res) => {
  try {
    const runs = await prisma.payrollRun.findMany({
      where: { companyId: req.user.companyId },
      include: {
        entries: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
      },
      orderBy: [{ periodStart: "desc" }],
    });

    return res.status(200).json({
      message: "Company payroll runs retrieved successfully.",
      data: runs,
    });
  } catch (error) {
    console.error("Error in getAllPayrollRecords:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const createOrUpdatePayRate = async (req, res) => {
  try {
    const employeeId = String(req.params.employeeId);
    const { hourlyRate } = req.body;

    if (hourlyRate == null || Number.isNaN(Number(hourlyRate))) {
      return res
        .status(400)
        .json({ message: "hourlyRate is required and must be a number." });
    }

    const user = await prisma.user.findFirst({
      where: { id: employeeId, companyId: req.user.companyId },
    });
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found in your company." });
    }

    const created = await prisma.userRate.create({
      data: { userId: employeeId, hourlyRate: Number(hourlyRate) },
    });

    return res.status(200).json({
      message: "Hourly rate saved successfully.",
      data: created,
    });
  } catch (error) {
    console.error("Error in createOrUpdatePayRate:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updatePayrollSettings = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const {
      frequency,
      firstCutoffEndDay,
      paydayOffsetDays,
      timezone,
      isActive,
    } = req.body;

    let schedule = await prisma.paySchedule.findFirst({
      where: { companyId, isActive: true },
    });

    if (!schedule) {
      schedule = await prisma.paySchedule.create({
        data: {
          companyId,
          frequency: frequency || "semimonthly",
          firstCutoffEndDay: firstCutoffEndDay ?? 15,
          paydayOffsetDays: paydayOffsetDays ?? 5,
          timezone: timezone || "Asia/Manila",
          isActive: isActive !== false,
        },
      });
    } else {
      schedule = await prisma.paySchedule.update({
        where: { id: schedule.id },
        data: {
          ...(frequency ? { frequency } : {}),
          ...(firstCutoffEndDay != null
            ? { firstCutoffEndDay: Number(firstCutoffEndDay) }
            : {}),
          ...(paydayOffsetDays != null
            ? { paydayOffsetDays: Number(paydayOffsetDays) }
            : {}),
          ...(timezone ? { timezone } : {}),
          ...(typeof isActive === "boolean" ? { isActive } : {}),
        },
      });
    }

    return res.status(200).json({
      message: "Payroll settings updated successfully.",
      data: schedule,
    });
  } catch (error) {
    console.error("Error in updatePayrollSettings:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getPayrollSettings = async (req, res) => {
  try {
    const schedule = await getActivePaySchedule(req.user.companyId);
    if (!schedule) {
      return res
        .status(404)
        .json({ message: "No active payroll settings found." });
    }
    return res.status(200).json({
      message: "Payroll settings retrieved successfully.",
      data: schedule,
    });
  } catch (error) {
    console.error("Error in getPayrollSettings:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const createOrGetRun = async ({ companyId, periodStart, periodEnd }) => {
  const existing = await prisma.payrollRun.findUnique({
    where: {
      companyId_periodStart_periodEnd: { companyId, periodStart, periodEnd },
    },
  });
  if (existing) return existing;

  const activeSchedule = await prisma.paySchedule.findFirst({
    where: { companyId, isActive: true },
  });

  return prisma.payrollRun.create({
    data: {
      companyId,
      scheduleId: activeSchedule ? activeSchedule.id : null,
      periodStart,
      periodEnd,
      status: "draft",
    },
  });
};

const calculatePayrollForUser = async (req, res) => {
  try {
    const { userId, periodStart, periodEnd, finalize } = req.body;
    const companyId = req.user.companyId;

    if (!periodStart || !periodEnd) {
      return res.status(400).json({
        message: "periodStart and periodEnd are required (ISO dates).",
      });
    }

    const start = toDate(periodStart);
    const end = toDate(periodEnd);
    const { s, e } = clampPeriod(start, end);

    const run = await createOrGetRun({
      companyId,
      periodStart: s,
      periodEnd: e,
    });

    if (userId) {
      const user = await prisma.user.findFirst({
        where: { id: String(userId), companyId },
      });
      if (!user)
        return res
          .status(404)
          .json({ message: "User not found in your company." });
      await computeEntryForUser({ run, userId: String(userId) });
    } else {
      const users = await prisma.user.findMany({
        where: { ...HUMAN_ONLY, companyId, status: "active" },
        select: { id: true },
      });
      for (const u of users) {
        await computeEntryForUser({ run, userId: u.id });
      }
    }

    const totals = await prisma.payrollEntry.aggregate({
      _sum: { grossPay: true, netPay: true },
      where: { runId: run.id },
    });

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        totalGross: totals._sum.grossPay || 0,
        totalNet: totals._sum.netPay || 0,
        status: "draft",
      },
    });

    if (finalize) {
      const locked = await finalizeRunInternal(run.id);
      return res
        .status(200)
        .json({ message: "Run computed and finalized.", data: locked });
    }

    const full = await prisma.payrollRun.findUnique({
      where: { id: run.id },
      include: { entries: { include: { user: true, lines: true } } },
    });

    return res
      .status(200)
      .json({ message: "Payroll calculation successful.", data: full });
  } catch (error) {
    console.error("Error in calculatePayrollForUser:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

async function finalizeRunInternal(runId) {
  const run = await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "finalized" },
  });

  const entries = await prisma.payrollEntry.findMany({ where: { runId } });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.payslipNumber) {
      const stamp = run.periodStart.toISOString().slice(0, 10);
      const seq = String(i + 1).padStart(4, "0");
      await prisma.payrollEntry.update({
        where: { id: e.id },
        data: { payslipNumber: `${stamp}-${run.companyId.slice(0, 6)}-${seq}` },
      });
    }
  }

  return prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { entries: true },
  });
}

const createPayrollRun = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { periodStart, periodEnd } = req.body;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({
        message: "periodStart and periodEnd are required (ISO dates).",
      });
    }
    const { s, e } = clampPeriod(toDate(periodStart), toDate(periodEnd));
    const run = await createOrGetRun({
      companyId,
      periodStart: s,
      periodEnd: e,
    });
    return res
      .status(200)
      .json({ message: "Run created or retrieved.", data: run });
  } catch (error) {
    console.error("Error in createPayrollRun:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const finalizePayrollRun = async (req, res) => {
  try {
    const runId = String(req.params.runId);
    const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
    if (!run || run.companyId !== req.user.companyId) {
      return res.status(404).json({ message: "Run not found." });
    }
    const locked = await finalizeRunInternal(runId);
    return res.status(200).json({ message: "Run finalized.", data: locked });
  } catch (error) {
    console.error("Error in finalizePayrollRun:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const listPayrollRuns = async (req, res) => {
  try {
    const runs = await prisma.payrollRun.findMany({
      where: { companyId: req.user.companyId },
      orderBy: [{ periodStart: "desc" }],
    });
    return res.status(200).json({ message: "Runs retrieved.", data: runs });
  } catch (error) {
    console.error("Error in listPayrollRuns:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getPayrollRun = async (req, res) => {
  try {
    const runId = String(req.params.runId);
    const run = await prisma.payrollRun.findFirst({
      where: { id: runId, companyId: req.user.companyId },
      include: { entries: { include: { user: true, lines: true } } },
    });
    if (!run) return res.status(404).json({ message: "Run not found." });
    return res.status(200).json({ message: "Run retrieved.", data: run });
  } catch (error) {
    console.error("Error in getPayrollRun:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const generatePayrollPDF = async (req, res) => {
  try {
    const entryId = String(req.params.recordId);
    const entry = await prisma.payrollEntry.findUnique({
      where: { id: entryId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        run: true,
        lines: true,
      },
    });
    if (!entry) {
      return res.status(404).json({ message: "Payroll entry not found." });
    }
    if (
      req.user.role !== "admin" &&
      req.user.role !== "superadmin" &&
      entry.userId !== req.user.id
    ) {
      return res
        .status(403)
        .json({ message: "Forbidden: This record is not accessible." });
    }

    return res.status(200).json({
      message: "Payroll entry retrieved.",
      data: entry,
    });
  } catch (error) {
    console.error("Error in generatePayrollPDF:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  getMyPayrollRecords,
  getAllPayrollRecords,
  createOrUpdatePayRate,
  updatePayrollSettings,
  getPayrollSettings,
  calculatePayrollForUser,
  generatePayrollPDF,
  createPayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  listPayrollRuns,
};
