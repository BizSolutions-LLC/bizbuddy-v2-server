"use strict";

const { DisbursementError } = require("./disbursementErrors");

function readDisbursementApiConfig() {
  const baseUrl = String(process.env.DISBURSEMENT_API_URL || "").replace(/\/$/, "");
  const apiKey = process.env.DISBURSEMENT_API_KEY || "";
  return {
    baseUrl,
    apiKey,
    configured: Boolean(baseUrl && apiKey),
  };
}

function accountIsReady(account) {
  return Boolean(account?.status === "verified" && account.bankLinked);
}

function detailMessage(payload) {
  const detail = payload?.detail ?? payload?.message;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const first = detail.find((item) => item?.msg || item?.message);
    if (first) return first.msg || first.message;
  }
  return "Disbursement service request failed.";
}

async function disbursementApiRequest(path, { method = "GET", body } = {}) {
  const config = readDisbursementApiConfig();
  if (!config.configured) {
    throw new DisbursementError("Payment provider is not configured; this action is unavailable.", {
      status: 501,
      code: "PROVIDER_NOT_CONFIGURED",
    });
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "x-api-key": config.apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new DisbursementError(detailMessage(payload), {
      status: response.status,
      code: response.status >= 500 ? "PROVIDER_ERROR" : "DISBURSEMENT_API_REJECTED",
    });
  }

  return payload;
}

function accountPath(provider, ownerType, ownerId) {
  const encodedOwner = encodeURIComponent(ownerId);
  if (provider === "stripe") {
    return `/internal/stripe/payment-accounts/${ownerType}/${encodedOwner}`;
  }
  return `/internal/payment-accounts/${ownerType}/${encodedOwner}`;
}

function serializeAccount(provider, row, fallback = {}) {
  if (!row) {
    return {
      provider,
      ownerType: fallback.ownerType || null,
      ownerId: fallback.ownerId || null,
      status: null,
      taxService: null,
      bankLinked: false,
    };
  }
  return {
    provider,
    ownerType: row.owner_type || fallback.ownerType || null,
    ownerId: row.owner_id || fallback.ownerId || null,
    status: row.status || null,
    taxService: provider === "moov" ? Boolean(row.tax_service) : null,
    bankLinked: Boolean(row.bank_linked),
  };
}

function bankBody(bank) {
  if (!bank) return null;
  return {
    holder_name: bank.holderName,
    holder_type: bank.holderType,
    bank_account_type: bank.bankAccountType,
    routing_number: bank.routingNumber,
    account_number: bank.accountNumber,
  };
}

async function loadProviderAccount(provider, ownerType, ownerId) {
  const row = await disbursementApiRequest(accountPath(provider, ownerType, ownerId));
  return serializeAccount(provider, row, { ownerType, ownerId });
}

async function resolveCompanyProvider(companyId) {
  const { configured } = readDisbursementApiConfig();
  const empty = serializeAccount(null, null, { ownerType: "company", ownerId: companyId });
  if (!configured) return { provider: null, account: empty, configured: false };

  const [moov, stripe] = await Promise.all([
    loadProviderAccount("moov", "company", companyId),
    loadProviderAccount("stripe", "company", companyId),
  ]);
  const moovExists = Boolean(moov.status);
  const stripeExists = Boolean(stripe.status);
  if (moovExists && stripeExists) {
    throw new DisbursementError(
      "This company has both a Moov and a Stripe funding account. Use one provider.",
      { status: 409, code: "MULTIPLE_PAYOUT_PROVIDERS" }
    );
  }
  if (moovExists) return { provider: "moov", account: moov, configured: true };
  if (stripeExists) return { provider: "stripe", account: stripe, configured: true };
  return { provider: null, account: empty, configured: true };
}

function onboardingPath(provider) {
  return provider === "stripe"
    ? "/internal/stripe/payment-accounts/onboarding"
    : "/internal/payment-accounts/onboarding";
}

function submitPath(provider, batchId) {
  const encoded = encodeURIComponent(batchId);
  return provider === "stripe"
    ? `/internal/stripe/disbursements/${encoded}/submit`
    : `/internal/disbursements/${encoded}/submit`;
}

module.exports = {
  readDisbursementApiConfig,
  disbursementApiRequest,
  accountPath,
  serializeAccount,
  bankBody,
  accountIsReady,
  loadProviderAccount,
  resolveCompanyProvider,
  onboardingPath,
  submitPath,
};
