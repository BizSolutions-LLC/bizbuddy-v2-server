"use strict";

const { prisma } = require("../../config/connection");
const { DisbursementError } = require("../../services/Disbursement/disbursementErrors");
const {
  readDisbursementApiConfig,
  disbursementApiRequest,
  serializeAccount,
  bankBody,
  loadProviderAccount,
  resolveCompanyProvider,
  onboardingPath,
  accountIsReady,
} = require("../../services/Disbursement/disbursementApiClient");

function handleError(res, error, context) {
  if (error instanceof DisbursementError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
  console.error(`Disbursement payout ${context}:`, error);
  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
}

function emptyAccount(provider, ownerType, ownerId) {
  return serializeAccount(provider, null, { ownerType, ownerId });
}

function assertProviderChoice(provider) {
  const value = String(provider || "").toLowerCase();
  if (value !== "moov" && value !== "stripe") {
    throw new DisbursementError("Choose Moov or Stripe.", { status: 400, code: "INVALID_PROVIDER" });
  }
  return value;
}

async function rememberEmployeeLink(employeeId, account) {
  const linked = Boolean(account?.status === "verified" || account?.bankLinked);
  await prisma.employeePayrollDetails.upsert({
    where: { userId: employeeId },
    update: { payoutAccountLinked: linked },
    create: { userId: employeeId, payoutAccountLinked: linked },
  });
}

async function assertEmployeeInCompany(companyId, employeeId) {
  const employee = await prisma.user.findFirst({
    where: { id: employeeId, companyId },
    select: { id: true },
  });
  if (!employee) {
    throw new DisbursementError("Employee not found.", { status: 404, code: "EMPLOYEE_NOT_FOUND" });
  }
}

function withConfig(account) {
  return { ...account, configured: readDisbursementApiConfig().configured };
}

exports.getPayoutProvider = async (req, res) => {
  try {
    const resolved = await resolveCompanyProvider(req.user.companyId);
    return res.status(200).json({
      success: true,
      data: { provider: resolved.provider, configured: resolved.configured },
    });
  } catch (error) {
    return handleError(res, error, "getPayoutProvider");
  }
};

exports.getCompanyPayoutAccount = async (req, res) => {
  try {
    const resolved = await resolveCompanyProvider(req.user.companyId);
    return res.status(200).json({ success: true, data: withConfig(resolved.account) });
  } catch (error) {
    return handleError(res, error, "getCompanyPayoutAccount");
  }
};

exports.saveCompanyPayoutAccount = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const provider = assertProviderChoice(req.body?.provider);
    const existing = await resolveCompanyProvider(companyId);
    if (existing.provider && existing.provider !== provider) {
      throw new DisbursementError(`This company is already linked with ${existing.provider}.`, {
        status: 409,
        code: "PROVIDER_ALREADY_LINKED",
      });
    }
    await disbursementApiRequest(onboardingPath(provider), {
      method: "POST",
      body: {
        owner_type: "company",
        owner_id: companyId,
        email: req.body?.email,
        legal_name: req.body?.legalName,
        business_type: provider === "moov" ? req.body?.businessType || null : null,
        terms_of_service_token: provider === "moov" ? req.body?.termsOfServiceToken || null : null,
        bank: bankBody(req.body?.bank),
      },
    });
    const data = await loadProviderAccount(provider, "company", companyId);
    return res.status(200).json({ success: true, data: withConfig(data) });
  } catch (error) {
    return handleError(res, error, "saveCompanyPayoutAccount");
  }
};

exports.verifyCompanyBank = async (req, res) => {
  try {
    const resolved = await resolveCompanyProvider(req.user.companyId);
    if (resolved.provider !== "moov") {
      throw new DisbursementError("Bank verification is only used for Moov payout accounts.", {
        status: 409,
        code: "BANK_VERIFICATION_UNAVAILABLE",
      });
    }
    await disbursementApiRequest(`/internal/payment-accounts/${encodeURIComponent(req.user.companyId)}/bank-verification`, {
      method: "POST",
      body: { code: req.body?.code },
    });
    const data = await loadProviderAccount("moov", "company", req.user.companyId);
    return res.status(200).json({ success: true, data: withConfig(data) });
  } catch (error) {
    return handleError(res, error, "verifyCompanyBank");
  }
};

exports.updateCompanyTaxService = async (req, res) => {
  try {
    const resolved = await resolveCompanyProvider(req.user.companyId);
    if (resolved.provider !== "moov") {
      throw new DisbursementError("Tax service is only used for Moov payout accounts.", {
        status: 409,
        code: "TAX_SERVICE_UNAVAILABLE",
      });
    }
    await disbursementApiRequest(`/internal/payment-accounts/${encodeURIComponent(req.user.companyId)}/tax-service`, {
      method: "PUT",
      body: { enabled: Boolean(req.body?.enabled) },
    });
    const data = await loadProviderAccount("moov", "company", req.user.companyId);
    return res.status(200).json({ success: true, data: withConfig(data) });
  } catch (error) {
    return handleError(res, error, "updateCompanyTaxService");
  }
};

async function employeeAccountResponse(companyId, employeeId) {
  const resolved = await resolveCompanyProvider(companyId);
  if (!resolved.configured) {
    return {
      ...emptyAccount(null, "employee", employeeId),
      configured: false,
      companyReady: false,
    };
  }
  if (!resolved.provider) {
    return {
      ...emptyAccount(null, "employee", employeeId),
      configured: true,
      companyReady: false,
    };
  }
  const account = await loadProviderAccount(resolved.provider, "employee", employeeId);
  return {
    ...account,
    configured: true,
    companyReady: accountIsReady(resolved.account),
  };
}

function assertEmployeeRole(req) {
  if (String(req.user.role || "").toLowerCase() !== "employee") {
    throw new DisbursementError("Employees connect their own payout account.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

exports.getMyPayoutAccount = async (req, res) => {
  try {
    assertEmployeeRole(req);
    const data = await employeeAccountResponse(req.user.companyId, req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "getMyPayoutAccount");
  }
};

async function onboardEmployeePayout(companyId, employeeId, body) {
  const resolved = await resolveCompanyProvider(companyId);
  if (!resolved.provider) {
    throw new DisbursementError("Link a company funding account before adding an employee payout account.", {
      status: 409,
      code: "COMPANY_FUNDING_NOT_READY",
    });
  }
  await disbursementApiRequest(onboardingPath(resolved.provider), {
    method: "POST",
    body: {
      owner_type: "employee",
      owner_id: employeeId,
      email: body?.email,
      first_name: body?.firstName,
      last_name: body?.lastName,
      bank: bankBody(body?.bank),
    },
  });
  const data = await employeeAccountResponse(companyId, employeeId);
  await rememberEmployeeLink(employeeId, data);
  return data;
}

exports.saveMyPayoutAccount = async (req, res) => {
  try {
    assertEmployeeRole(req);
    const data = await onboardEmployeePayout(req.user.companyId, req.user.id, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "saveMyPayoutAccount");
  }
};

exports.saveEmployeePayoutAccount = async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    await assertEmployeeInCompany(req.user.companyId, employeeId);
    const data = await onboardEmployeePayout(req.user.companyId, employeeId, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "saveEmployeePayoutAccount");
  }
};

exports.getEmployeePayoutAccount = async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    await assertEmployeeInCompany(req.user.companyId, employeeId);
    const data = await employeeAccountResponse(req.user.companyId, employeeId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "getEmployeePayoutAccount");
  }
};

exports.updateEmployeePayoutDelivery = async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    const delivery = String(req.body?.delivery || "").toLowerCase();
    if (delivery !== "automatic" && delivery !== "manual") {
      throw new DisbursementError("Choose automatic or manual.", { status: 400, code: "INVALID_DELIVERY" });
    }
    await assertEmployeeInCompany(req.user.companyId, employeeId);
    await prisma.employeePayrollDetails.upsert({
      where: { userId: employeeId },
      update: { payoutDelivery: delivery },
      create: { userId: employeeId, payoutDelivery: delivery },
    });
    const openRecipients = await prisma.disbursementRecipient.findMany({
      where: {
        employeeId,
        status: { not: "PAID" },
        batch: {
          companyId: req.user.companyId,
          status: { notIn: ["COMPLETED", "CANCELLED", "PROCESSING"] },
        },
      },
    });
    await Promise.all(openRecipients.map((recipient) => {
      const issues = Array.isArray(recipient.issues) ? recipient.issues : [];
      const nextIssues = delivery === "manual"
        ? issues.filter((issue) => issue?.code !== "MISSING_PAYOUT_SETUP")
        : issues;
      const hasBlocking = nextIssues.some((issue) => issue?.severity === "BLOCKING");
      const hasWarning = nextIssues.some((issue) => issue?.severity === "WARNING");
      let status = recipient.status;
      if (delivery === "manual" && ["WARNING", "READY", "PENDING"].includes(recipient.status)) {
        status = hasBlocking ? "BLOCKED" : hasWarning ? "WARNING" : "READY";
      }
      return prisma.disbursementRecipient.update({
        where: { id: recipient.id },
        data: {
          paymentMethod: delivery === "manual" ? "OTHER" : null,
          payoutProviderAccountId: null,
          issues: nextIssues,
          status,
        },
      });
    }));
    return res.status(200).json({ success: true, data: { employeeId, payoutDelivery: delivery } });
  } catch (error) {
    return handleError(res, error, "updateEmployeePayoutDelivery");
  }
};
