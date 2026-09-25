"use strict";

const VARIANCE_THRESHOLD = 0.25;

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildIdempotencyKey(companyId, payrollRunId) {
  return `bizbuddy:disbursement:${companyId}:${payrollRunId}`;
}

function extractSnapshotEmployees(payrollSnapshot) {
  if (!payrollSnapshot || typeof payrollSnapshot !== "object") return [];
  return Array.isArray(payrollSnapshot.employees) ? payrollSnapshot.employees : [];
}

function previousNetMap(payrollSnapshot) {
  const map = new Map();
  for (const emp of extractSnapshotEmployees(payrollSnapshot)) {
    const id = emp.employeeId || emp.id;
    if (!id) continue;
    map.set(String(id), roundMoney(emp.netPay ?? emp.netPayAfterTaxes));
  }
  return map;
}

function employeeDisplayName(user) {
  const profile = user?.profile;
  const parts = [profile?.firstName, profile?.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return user?.username || user?.email || user?.id || "Unknown";
}

/**
 * Pure snapshot → recipient plan. Does not write to the database.
 */
function buildRecipientPlan({
  snapshotEmployees,
  usersById,
  previousNetByEmployeeId = new Map(),
  currency = "USD",
}) {
  const seen = new Map();
  const recipients = [];
  const blockingIssues = [];
  const warningIssues = [];

  (snapshotEmployees || []).forEach((emp, index) => {
    const employeeId = emp?.employeeId || emp?.id || null;
    const amount = roundMoney(emp?.netPay ?? emp?.netPayAfterTaxes);
    const issues = [];

    if (!employeeId) {
      const issue = {
        severity: "BLOCKING",
        code: "MISSING_EMPLOYEE_ID",
        message: `Snapshot row ${index + 1} is missing an employee ID.`,
      };
      issues.push(issue);
      blockingIssues.push({ ...issue, index });
      return;
    }

    if (seen.has(String(employeeId))) {
      const issue = {
        severity: "BLOCKING",
        code: "DUPLICATE_RECIPIENT",
        message: `Employee ${employeeId} appears more than once in the payroll snapshot.`,
      };
      issues.push(issue);
      blockingIssues.push({ ...issue, employeeId, index });
      const first = seen.get(String(employeeId));
      first.issues.push(issue);
      first.status = "BLOCKED";
      return;
    }

    if (!(amount > 0)) {
      issues.push({
        severity: "BLOCKING",
        code: "INVALID_AMOUNT",
        message: `Payable amount must be greater than zero (got ${amount}).`,
      });
    }

    const user = usersById.get(String(employeeId));
    if (!user) {
      const issue = {
        severity: "BLOCKING",
        code: "EMPLOYEE_NOT_IN_COMPANY",
        message: "Employee is missing or does not belong to this company.",
      };
      issues.push(issue);
      blockingIssues.push({ ...issue, employeeId, index });
      return;
    }

    const payoutProviderAccountId = user?.payrollDetails?.payoutProviderAccountId || null;
    const payoutProvider = user?.payrollDetails?.payoutProvider || null;

    if (!payoutProviderAccountId || !payoutProvider) {
      issues.push({
        severity: "WARNING",
        code: "MISSING_PAYOUT_SETUP",
        message: "Employee has no payout provider account configured.",
      });
    }

    const previousNet = previousNetByEmployeeId.get(String(employeeId));
    if (previousNet != null && previousNet > 0) {
      const delta = Math.abs(amount - previousNet) / previousNet;
      if (delta > VARIANCE_THRESHOLD) {
        issues.push({
          severity: "WARNING",
          code: "UNUSUAL_AMOUNT_CHANGE",
          message: `Net pay changed by ${(delta * 100).toFixed(1)}% versus the previous payroll (was ${previousNet.toFixed(2)}).`,
        });
      }
    }

    const hasBlocking = issues.some((issue) => issue.severity === "BLOCKING");
    const hasWarning = issues.some((issue) => issue.severity === "WARNING");
    const status = hasBlocking ? "BLOCKED" : hasWarning ? "WARNING" : "READY";

    issues.forEach((issue) => {
      const packed = { ...issue, employeeId, index };
      if (issue.severity === "BLOCKING") blockingIssues.push(packed);
      else warningIssues.push(packed);
    });

    const recipient = {
      employeeId: String(employeeId),
      employeeName: emp.employeeName || employeeDisplayName(user),
      amount,
      currency,
      payoutProviderAccountId,
      payoutProvider,
      status,
      issues,
    };
    seen.set(String(employeeId), recipient);
    recipients.push(recipient);
  });

  const totalAmount = roundMoney(recipients.reduce((sum, r) => sum + r.amount, 0));

  return {
    recipients,
    totalAmount,
    recipientCount: recipients.length,
    blockingIssues,
    warningIssues,
    hasBlockingErrors: blockingIssues.length > 0,
  };
}

function summarizeIssues(recipients = [], extraBlocking = [], extraWarnings = []) {
  const blockingIssues = [
    ...extraBlocking,
    ...recipients.flatMap((r) => (r.issues || []).filter((i) => i.severity === "BLOCKING")),
  ];
  const warningIssues = [
    ...extraWarnings,
    ...recipients.flatMap((r) => (r.issues || []).filter((i) => i.severity === "WARNING")),
  ];
  return {
    blockingIssues,
    warningIssues,
    hasBlockingErrors: blockingIssues.length > 0,
  };
}

module.exports = {
  VARIANCE_THRESHOLD,
  roundMoney,
  buildIdempotencyKey,
  extractSnapshotEmployees,
  previousNetMap,
  employeeDisplayName,
  buildRecipientPlan,
  summarizeIssues,
};
