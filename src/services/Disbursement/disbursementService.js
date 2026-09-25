"use strict";

const {
  DisbursementError,
  assertCanView,
  assertCanCreate,
  assertCanApprove,
  assertCanCancel,
  assertCanSubmit,
  assertCanMarkPaid,
  assertValidPaymentMethod,
  assertValidPaymentProof,
} = require("./disbursementErrors");
const {
  BATCH_STATUSES,
  RECIPIENT_STATUSES,
  AUDIT_ACTIONS,
  assertTransition,
  canModifyAmounts,
  canApprove,
  canCancel,
  canSubmit,
  canMarkPaid,
  isActiveBatchStatus,
} = require("./disbursementStateMachine");
const {
  roundMoney,
  buildIdempotencyKey,
  extractSnapshotEmployees,
  previousNetMap,
  employeeDisplayName,
  buildRecipientPlan,
} = require("./disbursementSnapshot");
const { getDisbursementProvider } = require("./providers/DisbursementProvider");

const ELIGIBLE_PAYROLL_STATUS = "finalized";

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function serializeBatch(batch, extras = {}) {
  if (!batch) return null;
  return {
    id: batch.id,
    companyId: batch.companyId,
    payrollRunId: batch.payrollRunId,
    currency: batch.currency,
    totalAmount: roundMoney(toNumber(batch.totalAmount)),
    recipientCount: batch.recipientCount,
    status: batch.status,
    idempotencyKey: batch.idempotencyKey,
    createdById: batch.createdById,
    approvedById: batch.approvedById,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    approvedAt: batch.approvedAt,
    submittedAt: batch.submittedAt,
    completedAt: batch.completedAt,
    failureCode: batch.failureCode,
    failureMessage: batch.failureMessage,
    providerBatchId: batch.providerBatchId,
    metadata: batch.metadata || null,
    createdBy: batch.createdBy
      ? {
          id: batch.createdBy.id,
          name: employeeDisplayName(batch.createdBy),
          email: batch.createdBy.email,
          role: batch.createdBy.role,
        }
      : null,
    approvedBy: batch.approvedBy
      ? {
          id: batch.approvedBy.id,
          name: employeeDisplayName(batch.approvedBy),
          email: batch.approvedBy.email,
          role: batch.approvedBy.role,
        }
      : null,
    paymentMarkedBy: batch.paymentMarkedBy
      ? {
          id: batch.paymentMarkedBy.id,
          name: employeeDisplayName(batch.paymentMarkedBy),
          email: batch.paymentMarkedBy.email,
          role: batch.paymentMarkedBy.role,
        }
      : null,
    paymentMethod: batch.paymentMethod || null,
    paymentMarkedAt: batch.paymentMarkedAt || null,
    paymentProof: batch.paymentProofFileName
      ? {
          hasProof: true,
          fileName: batch.paymentProofFileName,
          mimeType: batch.paymentProofMimeType,
        }
      : { hasProof: false },
    payrollRun: batch.payrollRun
      ? {
          id: batch.payrollRun.id,
          periodStart: batch.payrollRun.periodStart,
          periodEnd: batch.payrollRun.periodEnd,
          payDate: batch.payrollRun.payDate,
          status: batch.payrollRun.status,
          locked: batch.payrollRun.locked,
          totalNet: roundMoney(toNumber(batch.payrollRun.totalNet)),
        }
      : null,
    ...extras,
  };
}

function serializeRecipient(recipient) {
  return {
    id: recipient.id,
    batchId: recipient.batchId,
    employeeId: recipient.employeeId,
    employeeName: employeeDisplayName(recipient.employee),
    employeeNumber: recipient.employee?.employeeId || null,
    email: recipient.employee?.email || null,
    amount: roundMoney(toNumber(recipient.amount)),
    currency: recipient.currency,
    payoutProviderAccountId: recipient.payoutProviderAccountId,
    payoutProvider: recipient.employee?.payrollDetails?.payoutProvider || null,
    status: recipient.status,
    providerTransactionId: recipient.providerTransactionId,
    failureReason: recipient.failureReason,
    issues: recipient.issues || [],
    paymentMethod: recipient.paymentMethod || null,
    paymentMarkedAt: recipient.paymentMarkedAt || null,
    paymentMarkedBy: recipient.paymentMarkedBy
      ? {
          id: recipient.paymentMarkedBy.id,
          name: employeeDisplayName(recipient.paymentMarkedBy),
        }
      : null,
    paymentProof: recipient.paymentProofFileName
      ? {
          hasProof: true,
          fileName: recipient.paymentProofFileName,
          mimeType: recipient.paymentProofMimeType,
        }
      : { hasProof: false },
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt,
  };
}

function serializeAudit(event) {
  return {
    id: event.id,
    actorUserId: event.actorUserId,
    actorName: employeeDisplayName(event.actor),
    action: event.action,
    batchId: event.batchId,
    recipientId: event.recipientId,
    previousState: event.previousState,
    newState: event.newState,
    metadata: event.metadata || null,
    createdAt: event.createdAt,
  };
}

async function writeAudit(tx, {
  actorUserId,
  action,
  batchId,
  recipientId = null,
  previousState = null,
  newState = null,
  metadata = null,
}) {
  return tx.disbursementAuditEvent.create({
    data: {
      actorUserId,
      action,
      batchId,
      recipientId,
      previousState,
      newState,
      metadata,
    },
  });
}

function loadPrisma() {
  return require("../../config/connection").prisma;
}

function createDisbursementService({ prisma, provider } = {}) {
  const db = prisma || loadPrisma();
  const paymentProvider = provider || getDisbursementProvider();
  async function loadPayrollRun(tx, companyId, payrollRunId) {
    return tx.payrollRun.findFirst({
      where: { id: payrollRunId, companyId },
    });
  }

  async function loadPreviousPayrollRun(tx, companyId, currentRun) {
    return tx.payrollRun.findFirst({
      where: {
        companyId,
        locked: true,
        status: ELIGIBLE_PAYROLL_STATUS,
        id: { not: currentRun.id },
        periodEnd: { lt: currentRun.periodStart },
      },
      orderBy: { periodEnd: "desc" },
    });
  }

  async function assertNoActiveBatch(tx, payrollRunId) {
    const existing = await tx.disbursementBatch.findFirst({
      where: {
        payrollRunId,
        status: { not: BATCH_STATUSES.CANCELLED },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new DisbursementError(
        "An active disbursement batch already exists for this payroll run.",
        { status: 409, code: "DUPLICATE_DISBURSEMENT" }
      );
    }
  }

  async function loadUsersById(tx, companyId, employeeIds) {
    if (!employeeIds.length) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: employeeIds }, companyId },
      include: {
        profile: true,
        payrollDetails: {
          select: { payoutProvider: true, payoutProviderAccountId: true },
        },
      },
    });
    return new Map(users.map((user) => [user.id, user]));
  }

  function assertPayrollEligible(run) {
    if (!run) {
      throw new DisbursementError("Payroll run not found.", {
        status: 404,
        code: "PAYROLL_NOT_FOUND",
      });
    }
    if (!run.locked || run.status !== ELIGIBLE_PAYROLL_STATUS) {
      throw new DisbursementError(
        "Payroll must be locked and finalized before creating a disbursement batch.",
        { status: 409, code: "PAYROLL_NOT_FINALIZED" }
      );
    }
    const employees = extractSnapshotEmployees(run.payrollSnapshot);
    if (!employees.length) {
      throw new DisbursementError("Payroll run is missing a finalized employee snapshot.", {
        status: 409,
        code: "MISSING_PAYROLL_SNAPSHOT",
      });
    }
    return employees;
  }

  function recipientCreateData(batchId, planRecipient) {
    return {
      batchId,
      employeeId: planRecipient.employeeId,
      amount: planRecipient.amount,
      currency: planRecipient.currency,
      payoutProviderAccountId: planRecipient.payoutProviderAccountId,
      status: planRecipient.status,
      issues: planRecipient.issues,
    };
  }

  const batchInclude = {
    createdBy: { include: { profile: true } },
    approvedBy: { include: { profile: true } },
    paymentMarkedBy: { include: { profile: true } },
    payrollRun: {
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        payDate: true,
        status: true,
        locked: true,
        totalNet: true,
      },
    },
  };

  async function getBatchForCompany(tx, companyId, batchId) {
    const batch = await tx.disbursementBatch.findFirst({
      where: { id: batchId, companyId },
      include: batchInclude,
    });
    if (!batch) {
      throw new DisbursementError("Disbursement batch not found.", {
        status: 404,
        code: "BATCH_NOT_FOUND",
      });
    }
    return batch;
  }

  function assertNoBlockingRecipients(recipients) {
    const blocked = recipients.filter((r) => r.status === RECIPIENT_STATUSES.BLOCKED);
    if (blocked.length) {
      throw new DisbursementError(
        `Cannot proceed: ${blocked.length} recipient(s) have blocking errors.`,
        { status: 409, code: "BLOCKING_RECIPIENTS" }
      );
    }
  }

  function isPayableRecipient(recipient) {
    return recipient.status !== RECIPIENT_STATUSES.BLOCKED;
  }

  function isUnpaidPayableRecipient(recipient) {
    return isPayableRecipient(recipient) && recipient.status !== RECIPIENT_STATUSES.PAID;
  }

  function recipientPaymentProofData({ method, actorUserId, file, now }) {
    return {
      status: RECIPIENT_STATUSES.PAID,
      paymentMethod: method,
      paymentMarkedById: actorUserId,
      paymentMarkedAt: now,
      paymentProofFileName: file.originalname || "payment-proof",
      paymentProofMimeType: file.mimetype,
      paymentProofBytes: file.buffer,
    };
  }

  async function maybeCompleteBatchIfAllPaid(tx, batch, actorUserId, extraMetadata = {}) {
    const recipients = await tx.disbursementRecipient.findMany({
      where: { batchId: batch.id },
    });
    if (recipients.some(isUnpaidPayableRecipient)) return batch;
    if (batch.status === BATCH_STATUSES.COMPLETED) return batch;
    assertTransition(batch.status, BATCH_STATUSES.COMPLETED, "mark_paid");
    const now = new Date();
    const completed = await tx.disbursementBatch.update({
      where: { id: batch.id },
      data: {
        status: BATCH_STATUSES.COMPLETED,
        completedAt: now,
      },
      include: batchInclude,
    });
    await writeAudit(tx, {
      actorUserId,
      action: AUDIT_ACTIONS.BATCH_COMPLETED,
      batchId: batch.id,
      previousState: batch.status,
      newState: BATCH_STATUSES.COMPLETED,
      metadata: {
        recordedManually: true,
        completedViaRecipientMarks: true,
        ...extraMetadata,
      },
    });
    return completed;
  }

  async function revalidateBatch(tx, batch) {
    const run = await loadPayrollRun(tx, batch.companyId, batch.payrollRunId);
    const snapshotEmployees = assertPayrollEligible(run);
    const previous = await loadPreviousPayrollRun(tx, batch.companyId, run);
    const previousNets = previousNetMap(previous?.payrollSnapshot);
    const employeeIds = snapshotEmployees
      .map((emp) => emp.employeeId || emp.id)
      .filter(Boolean);
    const usersById = await loadUsersById(tx, batch.companyId, employeeIds);
    const plan = buildRecipientPlan({
      snapshotEmployees,
      usersById,
      previousNetByEmployeeId: previousNets,
      currency: batch.currency || "USD",
    });

    const stored = await tx.disbursementRecipient.findMany({
      where: { batchId: batch.id },
    });
    const storedByEmployee = new Map(stored.map((row) => [row.employeeId, row]));

    for (const planned of plan.recipients) {
      const row = storedByEmployee.get(planned.employeeId);
      if (!row) {
        throw new DisbursementError(
          "Disbursement recipients no longer match the finalized payroll snapshot.",
          { status: 409, code: "RECIPIENT_MISMATCH" }
        );
      }
      if (roundMoney(toNumber(row.amount)) !== planned.amount) {
        throw new DisbursementError(
          "Stored recipient amounts do not match the finalized payroll snapshot.",
          { status: 409, code: "AMOUNT_MISMATCH" }
        );
      }
    }

    const recomputedTotal = roundMoney(
      stored.reduce((sum, row) => sum + toNumber(row.amount), 0)
    );
    return { plan, stored, recomputedTotal };
  }

  async function getSummary({ companyId, role }) {
    assertCanView(role);

    const [batches, eligibleRuns, awaitingPayoutSetup] = await Promise.all([
      db.disbursementBatch.findMany({
        where: { companyId },
        select: { status: true, payrollRunId: true },
      }),
      db.payrollRun.findMany({
        where: { companyId, locked: true, status: ELIGIBLE_PAYROLL_STATUS },
        select: { id: true, totalNet: true },
      }),
      db.user.count({
        where: {
          companyId,
          status: "active",
          OR: [
            { payrollDetails: null },
            { payrollDetails: { payoutProviderAccountId: null } },
          ],
        },
      }),
    ]);

    const activeRunIds = new Set(
      batches.filter((b) => isActiveBatchStatus(b.status)).map((b) => b.payrollRunId)
    );
    const readyRuns = eligibleRuns.filter((run) => !activeRunIds.has(run.id));
    const totalPayrollReady = roundMoney(
      readyRuns.reduce((sum, run) => sum + toNumber(run.totalNet), 0)
    );

    const countByStatus = batches.reduce((acc, batch) => {
      acc[batch.status] = (acc[batch.status] || 0) + 1;
      return acc;
    }, {});

    return {
      totalPayrollReadyForDisbursement: totalPayrollReady,
      payrollBatchCount: eligibleRuns.length,
      employeesAwaitingPayoutSetup: awaitingPayoutSetup,
      batchesAwaitingApproval: countByStatus[BATCH_STATUSES.READY_FOR_REVIEW] || 0,
      batchesReadyForSubmission: countByStatus[BATCH_STATUSES.READY_FOR_DISBURSEMENT] || 0,
      completedBatches: countByStatus[BATCH_STATUSES.COMPLETED] || 0,
      failedOrExceptionBatches:
        (countByStatus[BATCH_STATUSES.FAILED] || 0) +
        (countByStatus[BATCH_STATUSES.NEEDS_REVIEW] || 0),
      currency: "USD",
    };
  }

  async function listBatches({ companyId, role, payrollRunId, status, limit = 50, offset = 0 }) {
    assertCanView(role);
    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const skip = Math.max(parseInt(offset, 10) || 0, 0);
    const where = { companyId };
    if (payrollRunId) where.payrollRunId = payrollRunId;
    if (status) where.status = status;

    const [batches, total] = await Promise.all([
      db.disbursementBatch.findMany({
        where,
        include: batchInclude,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      db.disbursementBatch.count({ where }),
    ]);

    return {
      batches: batches.map((batch) => serializeBatch(batch)),
      pagination: { total, limit: take, offset: skip },
    };
  }

  async function getBatch({ companyId, role, batchId }) {
    assertCanView(role);
    const batch = await getBatchForCompany(db, companyId, batchId);
    const [recipients, auditEvents] = await Promise.all([
      db.disbursementRecipient.findMany({
        where: { batchId },
        include: {
          employee: {
            include: {
              profile: true,
              payrollDetails: {
                select: { payoutProvider: true, payoutProviderAccountId: true },
              },
            },
          },
          paymentMarkedBy: { include: { profile: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      db.disbursementAuditEvent.findMany({
        where: { batchId },
        include: { actor: { include: { profile: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const serializedRecipients = recipients.map(serializeRecipient);
    const blockingIssues = serializedRecipients.flatMap((r) =>
      (r.issues || []).filter((i) => i.severity === "BLOCKING")
    );
    const warningIssues = serializedRecipients.flatMap((r) =>
      (r.issues || []).filter((i) => i.severity === "WARNING")
    );

    return serializeBatch(batch, {
      recipients: serializedRecipients,
      auditEvents: auditEvents.map(serializeAudit),
      blockingIssues,
      warningIssues,
      hasBlockingErrors: blockingIssues.length > 0,
      provider: {
        name: paymentProvider.name || "unconfigured",
        connected: paymentProvider.name !== "unconfigured",
        message: paymentProvider.name === "unconfigured"
          ? "Payment provider is not connected. Transfers are disabled."
          : null,
      },
    });
  }

  async function createFromPayrollRun({ companyId, actorUserId, role, payrollRunId }) {
    assertCanCreate(role);
    if (!payrollRunId) {
      throw new DisbursementError("Payroll run ID is required.", { status: 400, code: "MISSING_PAYROLL_RUN" });
    }

    try {
      return await db.$transaction(async (tx) => {
        const run = await loadPayrollRun(tx, companyId, payrollRunId);
        const snapshotEmployees = assertPayrollEligible(run);
        await assertNoActiveBatch(tx, run.id);

        const previous = await loadPreviousPayrollRun(tx, companyId, run);
        const previousNets = previousNetMap(previous?.payrollSnapshot);
        const employeeIds = [...new Set(
          snapshotEmployees.map((emp) => emp.employeeId || emp.id).filter(Boolean)
        )];
        const usersById = await loadUsersById(tx, companyId, employeeIds);
        const plan = buildRecipientPlan({
          snapshotEmployees,
          usersById,
          previousNetByEmployeeId: previousNets,
          currency: "USD",
        });

        if (!plan.recipients.length) {
          throw new DisbursementError("Payroll snapshot has no payable recipients.", {
            status: 409,
            code: "NO_RECIPIENTS",
          });
        }

        const idempotencyKey = buildIdempotencyKey(companyId, run.id);
        const batch = await tx.disbursementBatch.create({
          data: {
            companyId,
            payrollRunId: run.id,
            currency: "USD",
            totalAmount: plan.totalAmount,
            recipientCount: plan.recipientCount,
            status: BATCH_STATUSES.READY_FOR_REVIEW,
            idempotencyKey,
            activePayrollRunKey: run.id,
            createdById: actorUserId,
            metadata: {
              blockingIssues: plan.blockingIssues,
              warningIssues: plan.warningIssues,
              payrollPeriodStart: run.periodStart,
              payrollPeriodEnd: run.periodEnd,
            },
            recipients: {
              create: plan.recipients.map((recipient) =>
                recipientCreateData(undefined, recipient)
              ).map(({ batchId, ...rest }) => rest),
            },
          },
          include: batchInclude,
        });

        await writeAudit(tx, {
          actorUserId,
          action: AUDIT_ACTIONS.BATCH_CREATED,
          batchId: batch.id,
          previousState: null,
          newState: BATCH_STATUSES.READY_FOR_REVIEW,
          metadata: {
            payrollRunId: run.id,
            recipientCount: plan.recipientCount,
            totalAmount: plan.totalAmount,
            currency: "USD",
          },
        });

        return serializeBatch(batch, {
          hasBlockingErrors: plan.hasBlockingErrors,
          blockingIssues: plan.blockingIssues,
          warningIssues: plan.warningIssues,
        });
      });
    } catch (error) {
      if (error.code === "P2002") {
        throw new DisbursementError(
          "An active disbursement batch already exists for this payroll run.",
          { status: 409, code: "DUPLICATE_DISBURSEMENT" }
        );
      }
      throw error;
    }
  }

  async function approveBatch({ companyId, actorUserId, role, batchId }) {
    const loaded = await getBatchForCompany(db, companyId, batchId);
    assertCanApprove(role, { actorUserId, createdById: loaded.createdById });

    return db.$transaction(async (tx) => {
      const batch = await getBatchForCompany(tx, companyId, batchId);
      assertCanApprove(role, { actorUserId, createdById: batch.createdById });
      if (!canApprove(batch.status)) {
        assertTransition(batch.status, BATCH_STATUSES.APPROVED, "approve");
      }

      const { stored, recomputedTotal, plan } = await revalidateBatch(tx, batch);
      if (plan.hasBlockingErrors) {
        throw new DisbursementError(
          `Cannot proceed: ${plan.blockingIssues.length} blocking error(s) remain on this batch.`,
          { status: 409, code: "BLOCKING_RECIPIENTS" }
        );
      }
      assertNoBlockingRecipients(plan.recipients);
      assertNoBlockingRecipients(stored);

      const approved = await tx.disbursementBatch.update({
        where: { id: batch.id },
        data: {
          status: BATCH_STATUSES.APPROVED,
          approvedById: actorUserId,
          approvedAt: new Date(),
          totalAmount: recomputedTotal,
          recipientCount: stored.length,
        },
      });

      await writeAudit(tx, {
        actorUserId,
        action: AUDIT_ACTIONS.BATCH_APPROVED,
        batchId: batch.id,
        previousState: batch.status,
        newState: BATCH_STATUSES.APPROVED,
        metadata: {
          recipientCount: stored.length,
          totalAmount: recomputedTotal,
          currency: batch.currency,
        },
      });

      assertTransition(BATCH_STATUSES.APPROVED, BATCH_STATUSES.READY_FOR_DISBURSEMENT, "auto");

      const ready = await tx.disbursementBatch.update({
        where: { id: batch.id },
        data: { status: BATCH_STATUSES.READY_FOR_DISBURSEMENT },
        include: batchInclude,
      });

      await writeAudit(tx, {
        actorUserId,
        action: AUDIT_ACTIONS.BATCH_MODIFIED,
        batchId: batch.id,
        previousState: BATCH_STATUSES.APPROVED,
        newState: BATCH_STATUSES.READY_FOR_DISBURSEMENT,
        metadata: { reason: "auto_ready_after_approval" },
      });

      return serializeBatch(ready, { previousStatus: approved.status });
    });
  }

  async function cancelBatch({ companyId, actorUserId, role, batchId }) {
    assertCanCancel(role);

    return db.$transaction(async (tx) => {
      const batch = await getBatchForCompany(tx, companyId, batchId);
      if (!canCancel(batch.status)) {
        assertTransition(batch.status, BATCH_STATUSES.CANCELLED, "cancel");
      }
      assertTransition(batch.status, BATCH_STATUSES.CANCELLED, "cancel");

      const cancelled = await tx.disbursementBatch.update({
        where: { id: batch.id },
        data: {
          status: BATCH_STATUSES.CANCELLED,
          activePayrollRunKey: null,
        },
        include: batchInclude,
      });

      await writeAudit(tx, {
        actorUserId,
        action: AUDIT_ACTIONS.BATCH_CANCELLED,
        batchId: batch.id,
        previousState: batch.status,
        newState: BATCH_STATUSES.CANCELLED,
      });

      return serializeBatch(cancelled);
    });
  }

  async function submitBatch({ companyId, actorUserId, role, batchId }) {
    assertCanSubmit(role);

    const batch = await getBatchForCompany(db, companyId, batchId);
    if (!canSubmit(batch.status)) {
      assertTransition(batch.status, BATCH_STATUSES.PROCESSING, "submit");
    }

    const recipients = await db.disbursementRecipient.findMany({
      where: { batchId: batch.id },
    });
    assertNoBlockingRecipients(recipients);

    try {
      await paymentProvider.submitDisbursement({
        batch,
        recipients,
        idempotencyKey: batch.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof DisbursementError && error.code === "PROVIDER_NOT_CONFIGURED") {
        throw error;
      }
      await db.disbursementBatch.update({
        where: { id: batch.id },
        data: {
          status: BATCH_STATUSES.FAILED,
          failureCode: error.code || "PROVIDER_ERROR",
          failureMessage: error.message,
        },
      });
      await writeAudit(db, {
        actorUserId,
        action: AUDIT_ACTIONS.BATCH_FAILED,
        batchId: batch.id,
        previousState: batch.status,
        newState: BATCH_STATUSES.FAILED,
        metadata: { message: error.message },
      });
      throw new DisbursementError(error.message || "Disbursement submission failed.", {
        status: 502,
        code: "PROVIDER_ERROR",
      });
    }

    assertTransition(batch.status, BATCH_STATUSES.PROCESSING, "submit");

    const submitted = await db.disbursementBatch.update({
      where: { id: batch.id },
      data: {
        status: BATCH_STATUSES.PROCESSING,
        submittedAt: new Date(),
      },
      include: batchInclude,
    });

    await writeAudit(db, {
      actorUserId,
      action: AUDIT_ACTIONS.BATCH_SUBMITTED,
      batchId: batch.id,
      previousState: batch.status,
      newState: BATCH_STATUSES.PROCESSING,
    });

    return serializeBatch(submitted);
  }

  async function markPaymentSent({ companyId, actorUserId, role, batchId, paymentMethod, file }) {
    const method = assertValidPaymentMethod(paymentMethod);
    assertValidPaymentProof(file);

    return db.$transaction(async (tx) => {
      const batch = await getBatchForCompany(tx, companyId, batchId);
      assertCanMarkPaid(role, { actorUserId, approvedById: batch.approvedById });
      if (!canMarkPaid(batch.status)) {
        assertTransition(batch.status, BATCH_STATUSES.COMPLETED, "mark_paid");
      }
      assertTransition(batch.status, BATCH_STATUSES.COMPLETED, "mark_paid");

      const recipients = await tx.disbursementRecipient.findMany({
        where: { batchId: batch.id },
      });
      assertNoBlockingRecipients(recipients);

      const now = new Date();
      const remaining = recipients.filter(isUnpaidPayableRecipient);
      const proofData = recipientPaymentProofData({ method, actorUserId, file, now });

      if (remaining.length) {
        await tx.disbursementRecipient.updateMany({
          where: {
            batchId: batch.id,
            status: { notIn: [RECIPIENT_STATUSES.BLOCKED, RECIPIENT_STATUSES.PAID] },
          },
          data: proofData,
        });
      }

      const completed = await tx.disbursementBatch.update({
        where: { id: batch.id },
        data: {
          status: BATCH_STATUSES.COMPLETED,
          completedAt: now,
          paymentMethod: method,
          paymentMarkedById: actorUserId,
          paymentMarkedAt: now,
          paymentProofFileName: file.originalname || "payment-proof",
          paymentProofMimeType: file.mimetype,
          paymentProofBytes: file.buffer,
        },
        include: batchInclude,
      });

      await writeAudit(tx, {
        actorUserId,
        action: AUDIT_ACTIONS.BATCH_COMPLETED,
        batchId: batch.id,
        previousState: batch.status,
        newState: BATCH_STATUSES.COMPLETED,
        metadata: {
          paymentMethod: method,
          fileName: file.originalname || "payment-proof",
          mimeType: file.mimetype,
          recordedManually: true,
          remainingRecipientCount: remaining.length,
        },
      });

      return serializeBatch(completed);
    });
  }

  async function markRecipientPaymentSent({
    companyId,
    actorUserId,
    role,
    batchId,
    recipientId,
    paymentMethod,
    file,
  }) {
    const method = assertValidPaymentMethod(paymentMethod);
    assertValidPaymentProof(file);

    return db.$transaction(async (tx) => {
      const batch = await getBatchForCompany(tx, companyId, batchId);
      assertCanMarkPaid(role, { actorUserId, approvedById: batch.approvedById });
      if (!canMarkPaid(batch.status)) {
        assertTransition(batch.status, BATCH_STATUSES.COMPLETED, "mark_paid");
      }

      const recipient = await tx.disbursementRecipient.findFirst({
        where: { id: recipientId, batchId: batch.id },
      });
      if (!recipient) {
        throw new DisbursementError("Recipient not found.", {
          status: 404,
          code: "RECIPIENT_NOT_FOUND",
        });
      }
      if (recipient.status === RECIPIENT_STATUSES.BLOCKED) {
        throw new DisbursementError(
          "This recipient has blocking errors and cannot be marked as paid.",
          { status: 409, code: "RECIPIENT_BLOCKED" }
        );
      }
      if (recipient.status === RECIPIENT_STATUSES.PAID) {
        throw new DisbursementError("This employee has already been marked as paid.", {
          status: 409,
          code: "RECIPIENT_ALREADY_PAID",
        });
      }

      const now = new Date();
      await tx.disbursementRecipient.update({
        where: { id: recipient.id },
        data: recipientPaymentProofData({ method, actorUserId, file, now }),
      });

      await writeAudit(tx, {
        actorUserId,
        action: AUDIT_ACTIONS.RECIPIENT_STATUS_CHANGED,
        batchId: batch.id,
        recipientId: recipient.id,
        previousState: recipient.status,
        newState: RECIPIENT_STATUSES.PAID,
        metadata: {
          paymentMethod: method,
          fileName: file.originalname || "payment-proof",
          mimeType: file.mimetype,
          recordedManually: true,
          employeeId: recipient.employeeId,
        },
      });

      const completed = await maybeCompleteBatchIfAllPaid(tx, batch, actorUserId, {
        paymentMethod: method,
      });
      return serializeBatch(completed);
    });
  }

  async function getPaymentProof({ companyId, role, batchId }) {
    assertCanView(role);
    const batch = await db.disbursementBatch.findFirst({
      where: { id: batchId, companyId },
      select: {
        paymentProofBytes: true,
        paymentProofMimeType: true,
        paymentProofFileName: true,
      },
    });
    if (!batch) {
      throw new DisbursementError("Disbursement batch not found.", {
        status: 404,
        code: "BATCH_NOT_FOUND",
      });
    }
    if (!batch.paymentProofBytes) {
      throw new DisbursementError("No payment proof is attached to this batch.", {
        status: 404,
        code: "PROOF_NOT_FOUND",
      });
    }
    return {
      bytes: batch.paymentProofBytes,
      mimeType: batch.paymentProofMimeType || "application/octet-stream",
      fileName: batch.paymentProofFileName || "payment-proof",
    };
  }

  async function getRecipientPaymentProof({ companyId, role, batchId, recipientId }) {
    assertCanView(role);
    const batch = await db.disbursementBatch.findFirst({
      where: { id: batchId, companyId },
      select: { id: true },
    });
    if (!batch) {
      throw new DisbursementError("Disbursement batch not found.", {
        status: 404,
        code: "BATCH_NOT_FOUND",
      });
    }
    const recipient = await db.disbursementRecipient.findFirst({
      where: { id: recipientId, batchId: batch.id },
      select: {
        paymentProofBytes: true,
        paymentProofMimeType: true,
        paymentProofFileName: true,
      },
    });
    if (!recipient) {
      throw new DisbursementError("Recipient not found.", {
        status: 404,
        code: "RECIPIENT_NOT_FOUND",
      });
    }
    if (!recipient.paymentProofBytes) {
      throw new DisbursementError("No payment proof is attached for this employee.", {
        status: 404,
        code: "PROOF_NOT_FOUND",
      });
    }
    return {
      bytes: recipient.paymentProofBytes,
      mimeType: recipient.paymentProofMimeType || "application/octet-stream",
      fileName: recipient.paymentProofFileName || "payment-proof",
    };
  }

  async function updateRecipientAmount({ companyId, role, batchId, recipientId, amount }) {
    assertCanCreate(role);
    const batch = await getBatchForCompany(db, companyId, batchId);
    if (!canModifyAmounts(batch.status)) {
      throw new DisbursementError(
        "Recipient amounts cannot be modified after the batch leaves draft.",
        { status: 409, code: "AMOUNTS_IMMUTABLE" }
      );
    }
    const nextAmount = roundMoney(amount);
    if (!(nextAmount > 0)) {
      throw new DisbursementError("Amount must be greater than zero.", {
        status: 400,
        code: "INVALID_AMOUNT",
      });
    }
    return db.disbursementRecipient.update({
      where: { id: recipientId },
      data: { amount: nextAmount },
    });
  }

  return {
    getSummary,
    listBatches,
    getBatch,
    createFromPayrollRun,
    approveBatch,
    cancelBatch,
    submitBatch,
    markPaymentSent,
    markRecipientPaymentSent,
    getPaymentProof,
    getRecipientPaymentProof,
    updateRecipientAmount,
  };
}

function getDefaultDisbursementService() {
  if (!getDefaultDisbursementService.instance) {
    getDefaultDisbursementService.instance = createDisbursementService();
  }
  return getDefaultDisbursementService.instance;
}

module.exports = {
  createDisbursementService,
  getDefaultDisbursementService,
};
