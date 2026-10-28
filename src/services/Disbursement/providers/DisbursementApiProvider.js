"use strict";

const { DisbursementError } = require("../disbursementErrors");
const { DisbursementProvider } = require("./DisbursementProvider");
const {
  disbursementApiRequest,
  resolveCompanyProvider,
  submitPath,
  accountIsReady,
} = require("../disbursementApiClient");

class DisbursementApiProvider extends DisbursementProvider {
  constructor() {
    super();
    this.name = "disbursement-api";
  }

  async submitDisbursement({ batch }) {
    const resolved = await resolveCompanyProvider(batch.companyId);
    if (!resolved.provider || !accountIsReady(resolved.account)) {
      throw new DisbursementError("Link a verified company funding account before sending payouts.", {
        status: 422,
        code: "COMPANY_FUNDING_NOT_READY",
      });
    }
    return disbursementApiRequest(submitPath(resolved.provider, batch.id), { method: "POST" });
  }
}

module.exports = DisbursementApiProvider;
