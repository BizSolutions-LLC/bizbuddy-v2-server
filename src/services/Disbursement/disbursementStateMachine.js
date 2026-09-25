"use strict";

const { DisbursementError } = require("./disbursementErrors");

const BATCH_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  READY_FOR_REVIEW: "READY_FOR_REVIEW",
  APPROVED: "APPROVED",
  READY_FOR_DISBURSEMENT: "READY_FOR_DISBURSEMENT",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  CANCELLED: "CANCELLED",
});

const RECIPIENT_STATUSES = Object.freeze({
  PENDING: "PENDING",
  READY: "READY",
  WARNING: "WARNING",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  PAID: "PAID",
});

const AUDIT_ACTIONS = Object.freeze({
  BATCH_CREATED: "BATCH_CREATED",
  BATCH_MODIFIED: "BATCH_MODIFIED",
  BATCH_APPROVED: "BATCH_APPROVED",
  BATCH_CANCELLED: "BATCH_CANCELLED",
  BATCH_SUBMITTED: "BATCH_SUBMITTED",
  BATCH_COMPLETED: "BATCH_COMPLETED",
  BATCH_FAILED: "BATCH_FAILED",
  RECIPIENT_STATUS_CHANGED: "RECIPIENT_STATUS_CHANGED",
});

const ACTIVE_BATCH_STATUSES = Object.freeze(
  Object.values(BATCH_STATUSES).filter((status) => status !== BATCH_STATUSES.CANCELLED)
);

/**
 * Allowed transitions: fromStatus -> { toStatus: action }
 * Frontend never sets status directly; services call assertTransition.
 */
const TRANSITIONS = Object.freeze({
  [BATCH_STATUSES.DRAFT]: {
    [BATCH_STATUSES.READY_FOR_REVIEW]: "submit_review",
    [BATCH_STATUSES.CANCELLED]: "cancel",
  },
  [BATCH_STATUSES.READY_FOR_REVIEW]: {
    [BATCH_STATUSES.APPROVED]: "approve",
    [BATCH_STATUSES.CANCELLED]: "cancel",
    [BATCH_STATUSES.NEEDS_REVIEW]: "needs_review",
  },
  [BATCH_STATUSES.APPROVED]: {
    [BATCH_STATUSES.READY_FOR_DISBURSEMENT]: "auto",
    [BATCH_STATUSES.CANCELLED]: "cancel",
  },
  [BATCH_STATUSES.READY_FOR_DISBURSEMENT]: {
    [BATCH_STATUSES.PROCESSING]: "submit",
    [BATCH_STATUSES.COMPLETED]: "mark_paid",
    [BATCH_STATUSES.CANCELLED]: "cancel",
  },
  [BATCH_STATUSES.PROCESSING]: {
    [BATCH_STATUSES.COMPLETED]: "provider_success",
    [BATCH_STATUSES.FAILED]: "provider_failure",
    [BATCH_STATUSES.NEEDS_REVIEW]: "partial_failure",
  },
  [BATCH_STATUSES.FAILED]: {
    [BATCH_STATUSES.NEEDS_REVIEW]: "reopen",
  },
  [BATCH_STATUSES.NEEDS_REVIEW]: {
    [BATCH_STATUSES.READY_FOR_REVIEW]: "resubmit_review",
    [BATCH_STATUSES.CANCELLED]: "cancel",
  },
  [BATCH_STATUSES.COMPLETED]: {},
  [BATCH_STATUSES.CANCELLED]: {},
});

function canTransition(fromStatus, toStatus, action) {
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed || !allowed[toStatus]) return false;
  if (action && allowed[toStatus] !== action) return false;
  return true;
}

function assertTransition(fromStatus, toStatus, action) {
  if (!canTransition(fromStatus, toStatus, action)) {
    throw new DisbursementError(
      `Invalid disbursement status transition: ${fromStatus} → ${toStatus}${action ? ` (${action})` : ""}.`,
      { status: 409, code: "INVALID_STATE_TRANSITION" }
    );
  }
}

function isActiveBatchStatus(status) {
  return status !== BATCH_STATUSES.CANCELLED;
}

function canModifyAmounts(status) {
  return status === BATCH_STATUSES.DRAFT;
}

function isTerminalStatus(status) {
  return status === BATCH_STATUSES.COMPLETED || status === BATCH_STATUSES.CANCELLED;
}

function canSubmit(status) {
  return status === BATCH_STATUSES.READY_FOR_DISBURSEMENT;
}

function canMarkPaid(status) {
  return status === BATCH_STATUSES.READY_FOR_DISBURSEMENT;
}

function canApprove(status) {
  return status === BATCH_STATUSES.READY_FOR_REVIEW;
}

function canCancel(status) {
  return Boolean(TRANSITIONS[status] && TRANSITIONS[status][BATCH_STATUSES.CANCELLED]);
}

module.exports = {
  BATCH_STATUSES,
  RECIPIENT_STATUSES,
  AUDIT_ACTIONS,
  ACTIVE_BATCH_STATUSES,
  TRANSITIONS,
  canTransition,
  assertTransition,
  isActiveBatchStatus,
  canModifyAmounts,
  isTerminalStatus,
  canSubmit,
  canMarkPaid,
  canApprove,
  canCancel,
};
