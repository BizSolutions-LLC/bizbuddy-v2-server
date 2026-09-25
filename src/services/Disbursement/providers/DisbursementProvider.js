"use strict";

const { DisbursementError } = require("../disbursementErrors");

class DisbursementProvider {
  async createRecipient() {
    throw new Error("createRecipient is not implemented");
  }

  async getRecipientStatus() {
    throw new Error("getRecipientStatus is not implemented");
  }

  async submitDisbursement() {
    throw new Error("submitDisbursement is not implemented");
  }

  async getDisbursementStatus() {
    throw new Error("getDisbursementStatus is not implemented");
  }

  async handleWebhook() {
    throw new Error("handleWebhook is not implemented");
  }
}

class UnconfiguredDisbursementProvider extends DisbursementProvider {
  constructor() {
    super();
    this.name = "unconfigured";
  }

  #notConfigured(operation) {
    return new DisbursementError(
      `Payment provider is not configured; ${operation} is unavailable.`,
      { status: 501, code: "PROVIDER_NOT_CONFIGURED" }
    );
  }

  async createRecipient() {
    throw this.#notConfigured("createRecipient");
  }

  async getRecipientStatus() {
    throw this.#notConfigured("getRecipientStatus");
  }

  async submitDisbursement() {
    throw this.#notConfigured("submitDisbursement");
  }

  async getDisbursementStatus() {
    throw this.#notConfigured("getDisbursementStatus");
  }

  async handleWebhook() {
    throw this.#notConfigured("handleWebhook");
  }
}

function getDisbursementProvider() {
  return new UnconfiguredDisbursementProvider();
}

module.exports = {
  DisbursementProvider,
  UnconfiguredDisbursementProvider,
  getDisbursementProvider,
};
