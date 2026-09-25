function parseAmount(value) {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

function normalizeEarningCode(code) {
  return String(code || '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

function isDriverEarningType(earningType) {
  const code = normalizeEarningCode(earningType?.code);
  return code === 'driver' || code === 'driver_hours' || code.includes('driver');
}

function isRegularEarningType(earningType) {
  const code = normalizeEarningCode(earningType?.code);
  return code === 'regular_hours' || code === 'regular';
}

function isOvertimeEarningType(earningType) {
  const code = normalizeEarningCode(earningType?.code);
  return code === 'overtime' || code === 'ot' || code === 'ot_hours';
}

function employeePayRate(employee) {
  return parseAmount(employee.payrollDetails?.payRate ?? employee.payRate);
}

function employeeDriverRate(employee) {
  return parseAmount(employee.driverPayRate ?? employee.payrollDetails?.driverPayRate);
}

function resolveHoursForEarningType(earningType, hoursData) {
  if (!hoursData) return null;
  const code = normalizeEarningCode(earningType?.code);

  if (code === 'regular_hours' || code === 'regular') return hoursData.regularHours ?? null;
  if (code === 'overtime' || code === 'ot' || code === 'ot_hours') return hoursData.overtimeHours ?? null;
  if (isDriverEarningType(earningType)) return hoursData.driverHours ?? null;
  if (code === 'training' || code === 'training_hours' || code.includes('training')) {
    return hoursData.trainingHours ?? null;
  }
  if (code === 'pto' || code === 'pto_hours' || code.includes('pto')) return hoursData.ptoHours ?? null;

  return null;
}

function formatHours(hours) {
  if (hours == null || hours === '') return '-';
  const parsed = parseAmount(hours);
  return parsed.toFixed(2);
}

const FALLBACK_EARNINGS = {
  __fallback_regular: {
    label: 'Regular Hours Pay',
    hoursKey: 'regularHours',
    isRegular: true,
    isOvertime: false,
    isDriver: false,
  },
  __fallback_overtime: {
    label: 'Overtime Pay',
    hoursKey: 'overtimeHours',
    isRegular: false,
    isOvertime: true,
    isDriver: false,
  },
  __fallback_driver: {
    label: 'Driver/Aide Pay',
    hoursKey: 'driverHours',
    isRegular: false,
    isOvertime: false,
    isDriver: true,
  },
  __fallback_pto: {
    label: 'PTO',
    hoursKey: 'ptoHours',
    isRegular: false,
    isOvertime: false,
    isDriver: false,
  },
  __fallback_salary: {
    label: 'Salary',
    hoursKey: null,
    isRegular: false,
    isOvertime: false,
    isDriver: false,
  },
};

function pushFallbackRow(rows, earnings, hoursData, id, extraAmount) {
  if (rows.some((row) => row.id === id)) return;

  const meta = FALLBACK_EARNINGS[id];
  if (!meta) return;

  const hours = meta.hoursKey ? hoursData[meta.hoursKey] ?? null : null;
  const amount = parseAmount(earnings[id]) || parseAmount(extraAmount);

  if (amount <= 0) return;

  rows.push({
    id,
    label: meta.label,
    hours,
    amount,
    isRegular: meta.isRegular,
    isOvertime: meta.isOvertime,
    isDriver: meta.isDriver,
  });
}

function collectEarningRows(employee, earningTypes) {
  const earnings = employee.earnings || {};
  const hoursData = employee.hoursData || {};
  const rows = [];

  (earningTypes || []).forEach((et) => {
    const amount = parseAmount(earnings[et.id]);
    if (amount <= 0) return;
    rows.push({
      id: et.id,
      label: et.label,
      hours: resolveHoursForEarningType(et, hoursData),
      amount,
      isRegular: isRegularEarningType(et),
      isOvertime: isOvertimeEarningType(et),
      isDriver: isDriverEarningType(et),
    });
  });

  if (!rows.some((row) => row.isRegular)) {
    const regularHours = parseAmount(hoursData.regularHours);
    const payRate = employeePayRate(employee);
    const derivedAmount =
      regularHours > 0 && payRate > 0 ? round2(regularHours * payRate) : 0;
    pushFallbackRow(
      rows,
      earnings,
      hoursData,
      '__fallback_regular',
      parseAmount(earnings.regularPay) || derivedAmount
    );
  }

  if (!rows.some((row) => row.isOvertime)) {
    pushFallbackRow(rows, earnings, hoursData, '__fallback_overtime');
  }

  if (!rows.some((row) => row.isDriver)) {
    const driverHours = parseAmount(hoursData.driverHours);
    const driverRate = employeeDriverRate(employee);
    const derivedAmount =
      driverHours > 0 && driverRate > 0 ? round2(driverHours * driverRate) : 0;
    pushFallbackRow(rows, earnings, hoursData, '__fallback_driver', derivedAmount);
  }

  if (!rows.some((row) => row.id === '__fallback_pto')) {
    pushFallbackRow(rows, earnings, hoursData, '__fallback_pto');
  }

  if (!rows.some((row) => row.id === '__fallback_salary')) {
    pushFallbackRow(rows, earnings, hoursData, '__fallback_salary');
  }

  return rows.sort((a, b) => {
    const rank = (row) => {
      if (row.isRegular) return 0;
      if (row.isOvertime) return 1;
      if (row.isDriver) return 2;
      return 3;
    };
    return rank(a) - rank(b);
  });
}

function resolveEarningYtd(row, ytd) {
  const safeYTD = ytd || {};
  if (row.isDriver) return parseAmount(safeYTD.driverPay);
  if (row.isRegular) return parseAmount(safeYTD.regularPay);
  if (row.isOvertime) return parseAmount(safeYTD.overtimePay);
  const ytdField = String(row.id).replace(/([A-Z])/g, (match) => match.toLowerCase());
  return parseAmount(safeYTD[ytdField] || safeYTD[`${ytdField}Pay`]);
}

function resolveEarningRate(employee, row) {
  if (row.isDriver) return employeeDriverRate(employee);
  if (row.isRegular) return employeePayRate(employee);
  if (row.isOvertime) {
    const payRate = employeePayRate(employee);
    return payRate > 0 ? round2(payRate * 1.5) : 0;
  }
  return 0;
}

function formatRate(rate) {
  const parsed = parseAmount(rate);
  return parsed > 0 ? parsed.toFixed(2) : '-';
}

module.exports = {
  collectEarningRows,
  employeeDriverRate,
  employeePayRate,
  formatHours,
  formatRate,
  parseAmount,
  resolveEarningRate,
  resolveEarningYtd,
};
