"use strict";

const VIEW_ROLES = new Set(["admin", "supervisor", "superadmin"]);
const CREATE_ROLES = new Set(["admin", "superadmin"]);
const APPROVE_ROLES = new Set(["admin", "supervisor", "superadmin"]);
const MARK_PAID_ROLES = new Set(["admin", "superadmin"]);

const PAYMENT_METHODS = Object.freeze(["CHECK", "BANK_TRANSFER", "CASH", "OTHER"]);
const PROOF_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

class DisbursementError extends Error {
  constructor(message, { status = 400, code = "DISBURSEMENT_ERROR" } = {}) {
    super(message);
    this.name = "DisbursementError";
    this.status = status;
    this.code = code;
  }
}

function normalizeRole(role) {
  return String(role || "").toLowerCase();
}

function assertCanView(role) {
  if (!VIEW_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: insufficient permissions.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

function assertCanCreate(role) {
  if (!CREATE_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: cannot create disbursement batches.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

function assertCanApprove(role, { actorUserId, createdById } = {}) {
  if (!APPROVE_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: cannot approve disbursement batches.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
  if (actorUserId && createdById && actorUserId === createdById) {
    throw new DisbursementError(
      "A second person must approve this batch. You cannot approve a batch you created.",
      { status: 403, code: "CANNOT_APPROVE_OWN_BATCH" }
    );
  }
}

function assertCanCancel(role) {
  if (!CREATE_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: cannot cancel disbursement batches.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

function assertCanSubmit(role) {
  if (!CREATE_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: insufficient permissions.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

function assertCanMarkPaid(role, { actorUserId, approvedById } = {}) {
  if (!MARK_PAID_ROLES.has(normalizeRole(role))) {
    throw new DisbursementError("Access denied: cannot mark disbursement as paid.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
  if (actorUserId && approvedById && actorUserId === approvedById) {
    throw new DisbursementError(
      "A different administrator must record payment. The approver cannot mark this batch as paid.",
      { status: 403, code: "CANNOT_MARK_PAID_AS_APPROVER" }
    );
  }
}

function assertValidPaymentMethod(method) {
  if (!PAYMENT_METHODS.includes(String(method || "").toUpperCase())) {
    throw new DisbursementError("Select how payment was sent (check, bank transfer, cash, or other).", {
      status: 400,
      code: "INVALID_PAYMENT_METHOD",
    });
  }
  return String(method).toUpperCase();
}

function assertValidPaymentProof(file) {
  if (!file || !file.buffer || !file.buffer.length) {
    throw new DisbursementError("A payment-proof screenshot is required.", {
      status: 400,
      code: "PROOF_REQUIRED",
    });
  }
  if (file.size > MAX_PROOF_BYTES || file.buffer.length > MAX_PROOF_BYTES) {
    throw new DisbursementError("Payment proof must be 5MB or smaller.", {
      status: 400,
      code: "PROOF_TOO_LARGE",
    });
  }
  if (!PROOF_MIME_TYPES.includes(file.mimetype)) {
    throw new DisbursementError("Payment proof must be a PNG, JPEG, WebP, or PDF.", {
      status: 400,
      code: "INVALID_PROOF_TYPE",
    });
  }
}

module.exports = {
  VIEW_ROLES,
  CREATE_ROLES,
  APPROVE_ROLES,
  MARK_PAID_ROLES,
  PAYMENT_METHODS,
  PROOF_MIME_TYPES,
  MAX_PROOF_BYTES,
  DisbursementError,
  normalizeRole,
  assertCanView,
  assertCanCreate,
  assertCanApprove,
  assertCanCancel,
  assertCanSubmit,
  assertCanMarkPaid,
  assertValidPaymentMethod,
  assertValidPaymentProof,
};
