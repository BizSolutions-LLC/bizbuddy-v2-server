"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  canTransition,
  assertTransition,
  canModifyAmounts,
  BATCH_STATUSES,
} = require("../src/services/Disbursement/disbursementStateMachine");
const {
  buildRecipientPlan,
  buildIdempotencyKey,
  roundMoney,
  extractSnapshotEmployees,
} = require("../src/services/Disbursement/disbursementSnapshot");
const { DisbursementError } = require("../src/services/Disbursement/disbursementErrors");
const { createDisbursementService } = require("../src/services/Disbursement/disbursementService");
const {
  UnconfiguredDisbursementProvider,
} = require("../src/services/Disbursement/providers/DisbursementProvider");

function cuid(prefix = "id") {
  cuid.n = (cuid.n || 0) + 1;
  return `${prefix}_${cuid.n}`;
}

function makeUser(overrides = {}) {
  return {
    id: overrides.id || "emp-1",
    companyId: "co-1",
    email: "emp1@example.com",
    username: "emp1",
    employeeId: "E-001",
    role: "employee",
    status: "active",
    profile: { firstName: "Ada", lastName: "Lovelace" },
    payrollDetails: {
      payoutProvider: overrides.payoutProvider ?? null,
      payoutProviderAccountId: overrides.payoutProviderAccountId ?? null,
    },
    ...overrides,
  };
}

function makePayrollRun(overrides = {}) {
  return {
    id: "run-1",
    companyId: "co-1",
    locked: true,
    status: "finalized",
    periodStart: new Date("2026-08-01"),
    periodEnd: new Date("2026-08-15"),
    payDate: new Date("2026-08-20"),
    totalNet: 1500.5,
    payrollSnapshot: {
      employees: [
        { employeeId: "emp-1", employeeName: "Ada Lovelace", netPay: 1000.25 },
        { employeeId: "emp-2", employeeName: "Alan Turing", netPay: 500.25 },
      ],
    },
    ...overrides,
  };
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected == null) return row[key] == null;
    if (typeof expected !== "object") return row[key] === expected;
    if (expected.not !== undefined) return row[key] !== expected.not;
    if (expected.notIn) return !expected.notIn.includes(row[key]);
    if (expected.in) return expected.in.includes(row[key]);
    if (expected.lt) return row[key] < expected.lt;
    return true;
  });
}

function createFakePrisma(seed = {}) {
  const db = {
    payrollRuns: seed.payrollRuns || [],
    users: seed.users || [],
    batches: seed.batches || [],
    recipients: seed.recipients || [],
    audit: seed.audit || [],
  };

  function applyInclude(row, include, collection) {
    if (!include || !row) return { ...row };
    const out = { ...row };
    if (include.createdBy) {
      const user = db.users.find((u) => u.id === row.createdById);
      out.createdBy = user || { id: row.createdById, profile: null };
    }
    if (include.approvedBy) {
      const user = db.users.find((u) => u.id === row.approvedById);
      out.approvedBy = user || null;
    }
    if (include.paymentMarkedBy) {
      const user = db.users.find((u) => u.id === row.paymentMarkedById);
      out.paymentMarkedBy = user || null;
    }
    if (include.payrollRun) {
      out.payrollRun = db.payrollRuns.find((r) => r.id === row.payrollRunId) || null;
    }
    if (include.employee) {
      out.employee = db.users.find((u) => u.id === row.employeeId) || null;
    }
    if (include.actor) {
      out.actor = db.users.find((u) => u.id === row.actorUserId) || null;
    }
    if (include.recipients || collection === "withNestedRecipients") {
      out.recipients = db.recipients.filter((r) => r.batchId === row.id);
    }
    return out;
  }

  const prisma = {
    payrollRun: {
      async findFirst({ where, orderBy } = {}) {
        let rows = db.payrollRuns.filter((row) => matchesWhere(row, where));
        if (orderBy?.periodEnd === "desc") {
          rows = rows.sort((a, b) => b.periodEnd - a.periodEnd);
        }
        return rows[0] || null;
      },
      async findMany({ where } = {}) {
        return db.payrollRuns.filter((row) => matchesWhere(row, where));
      },
    },
    user: {
      async findMany({ where } = {}) {
        return db.users.filter((row) => {
          if (where.companyId && row.companyId !== where.companyId) return false;
          if (where.id?.in && !where.id.in.includes(row.id)) return false;
          return true;
        });
      },
      async count({ where } = {}) {
        return db.users.filter((row) => {
          if (where.companyId && row.companyId !== where.companyId) return false;
          if (where.status && row.status !== where.status) return false;
          if (where.OR) {
            return where.OR.some((clause) => {
              if (clause.payrollDetails === null) return !row.payrollDetails;
              if (clause.payrollDetails?.payoutProviderAccountId === null) {
                return !row.payrollDetails?.payoutProviderAccountId;
              }
              return false;
            });
          }
          return true;
        }).length;
      },
    },
    disbursementBatch: {
      async findFirst({ where, include, select } = {}) {
        const row = db.batches.find((batch) => matchesWhere(batch, where));
        if (!row) return null;
        if (select) {
          const picked = {};
          Object.keys(select).forEach((key) => {
            picked[key] = row[key];
          });
          return picked;
        }
        return applyInclude(row, include);
      },
      async findMany({ where, include, orderBy, take, skip } = {}) {
        let rows = db.batches.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === "desc") {
          rows = rows.sort((a, b) => b.createdAt - a.createdAt);
        }
        if (skip) rows = rows.slice(skip);
        if (take) rows = rows.slice(0, take);
        return rows.map((row) => applyInclude(row, include));
      },
      async count({ where } = {}) {
        return db.batches.filter((row) => matchesWhere(row, where)).length;
      },
      async create({ data, include }) {
        if (data.activePayrollRunKey && db.batches.some((b) => b.activePayrollRunKey === data.activePayrollRunKey)) {
          const err = new Error("Unique constraint");
          err.code = "P2002";
          throw err;
        }
        if (data.idempotencyKey && db.batches.some((b) => b.idempotencyKey === data.idempotencyKey)) {
          const err = new Error("Unique constraint");
          err.code = "P2002";
          throw err;
        }
        const id = data.id || cuid("batch");
        const now = new Date();
        const { recipients, ...rest } = data;
        const row = {
          failureCode: null,
          failureMessage: null,
          providerBatchId: null,
          approvedById: null,
          approvedAt: null,
          submittedAt: null,
          completedAt: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
          ...rest,
          id,
        };
        db.batches.push(row);
        if (recipients?.create) {
          recipients.create.forEach((item) => {
            db.recipients.push({
              id: cuid("rcp"),
              batchId: id,
              providerTransactionId: null,
              failureReason: null,
              createdAt: now,
              updatedAt: now,
              ...item,
            });
          });
        }
        return applyInclude(row, include);
      },
      async update({ where, data, include }) {
        const row = db.batches.find((batch) => batch.id === where.id);
        if (!row) throw new Error("Batch not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return applyInclude(row, include);
      },
    },
    disbursementRecipient: {
      async findFirst({ where, include, select } = {}) {
        const row = db.recipients.find((item) => matchesWhere(item, where));
        if (!row) return null;
        if (select) {
          const picked = {};
          Object.keys(select).forEach((key) => {
            picked[key] = row[key];
          });
          return picked;
        }
        return applyInclude(row, include);
      },
      async findMany({ where, include } = {}) {
        return db.recipients
          .filter((row) => matchesWhere(row, where))
          .map((row) => applyInclude(row, include));
      },
      async update({ where, data }) {
        const row = db.recipients.find((item) => item.id === where.id);
        if (!row) throw new Error("Recipient not found");
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        db.recipients.forEach((row) => {
          if (!matchesWhere(row, where)) return;
          Object.assign(row, data);
          count += 1;
        });
        return { count };
      },
    },
    disbursementAuditEvent: {
      async create({ data }) {
        const row = { id: cuid("aud"), createdAt: new Date(), recipientId: null, metadata: null, ...data };
        db.audit.push(row);
        return row;
      },
      async findMany({ where, include } = {}) {
        return db.audit
          .filter((row) => matchesWhere(row, where))
          .map((row) => applyInclude(row, include));
      },
    },
    async $transaction(fn) {
      return fn(prisma);
    },
    _db: db,
  };

  return prisma;
}

function createService(seed, provider) {
  const prisma = createFakePrisma(seed);
  const service = createDisbursementService({
    prisma,
    provider: provider || new UnconfiguredDisbursementProvider(),
  });
  return { prisma, service };
}

const actor = { companyId: "co-1", actorUserId: "admin-1", role: "admin" };
const secondAdmin = { companyId: "co-1", actorUserId: "admin-2", role: "admin" };
const supervisorActor = { companyId: "co-1", actorUserId: "supervisor-1", role: "supervisor" };
const superActor = { companyId: "co-1", actorUserId: "super-1", role: "superadmin" };

const paymentProof = {
  buffer: Buffer.from("fake-png-bytes"),
  mimetype: "image/png",
  originalname: "receipt.png",
  size: 14,
};

function defaultSeed() {
  return {
    payrollRuns: [makePayrollRun()],
    users: [
      makeUser({ id: "emp-1" }),
      makeUser({
        id: "emp-2",
        email: "emp2@example.com",
        username: "emp2",
        profile: { firstName: "Alan", lastName: "Turing" },
      }),
      makeUser({ id: "admin-1", role: "admin", username: "admin" }),
      makeUser({ id: "admin-2", role: "admin", username: "admin2" }),
      makeUser({ id: "supervisor-1", role: "supervisor", username: "supervisor" }),
      makeUser({ id: "super-1", role: "superadmin", username: "super" }),
    ],
  };
}

describe("disbursement state machine", () => {
  it("allows READY_FOR_REVIEW → APPROVED via approve", () => {
    assert.equal(
      canTransition(BATCH_STATUSES.READY_FOR_REVIEW, BATCH_STATUSES.APPROVED, "approve"),
      true
    );
  });

  it("rejects invalid transitions", () => {
    assert.equal(
      canTransition(BATCH_STATUSES.COMPLETED, BATCH_STATUSES.APPROVED, "approve"),
      false
    );
    assert.throws(
      () => assertTransition(BATCH_STATUSES.CANCELLED, BATCH_STATUSES.PROCESSING, "submit"),
      (err) => err instanceof DisbursementError && err.code === "INVALID_STATE_TRANSITION"
    );
  });

  it("freezes amounts after draft", () => {
    assert.equal(canModifyAmounts(BATCH_STATUSES.DRAFT), true);
    assert.equal(canModifyAmounts(BATCH_STATUSES.READY_FOR_REVIEW), false);
    assert.equal(canModifyAmounts(BATCH_STATUSES.APPROVED), false);
    assert.equal(canModifyAmounts(BATCH_STATUSES.READY_FOR_DISBURSEMENT), false);
  });
});

describe("disbursement snapshot planning", () => {
  it("computes recipient amounts and total from payroll snapshot netPay", () => {
    const usersById = new Map([
      ["emp-1", makeUser({ id: "emp-1", payoutProvider: "stripe", payoutProviderAccountId: "acct_1" })],
      ["emp-2", makeUser({ id: "emp-2", payoutProvider: "stripe", payoutProviderAccountId: "acct_2" })],
    ]);
    const plan = buildRecipientPlan({
      snapshotEmployees: extractSnapshotEmployees(makePayrollRun().payrollSnapshot),
      usersById,
    });
    assert.equal(plan.recipientCount, 2);
    assert.equal(plan.totalAmount, 1500.5);
    assert.equal(plan.recipients[0].amount, 1000.25);
    assert.equal(plan.recipients[1].amount, 500.25);
    assert.equal(plan.hasBlockingErrors, false);
  });

  it("marks missing payout setup as a warning, not a blocker", () => {
    const usersById = new Map([
      ["emp-1", makeUser({ id: "emp-1" })],
      ["emp-2", makeUser({ id: "emp-2" })],
    ]);
    const plan = buildRecipientPlan({
      snapshotEmployees: extractSnapshotEmployees(makePayrollRun().payrollSnapshot),
      usersById,
    });
    assert.equal(plan.hasBlockingErrors, false);
    assert.equal(plan.recipients[0].status, "WARNING");
    assert.ok(plan.warningIssues.some((issue) => issue.code === "MISSING_PAYOUT_SETUP"));
  });

  it("blocks duplicate recipients and invalid amounts", () => {
    const usersById = new Map([["emp-1", makeUser({ id: "emp-1" })]]);
    const plan = buildRecipientPlan({
      snapshotEmployees: [
        { employeeId: "emp-1", netPay: 10 },
        { employeeId: "emp-1", netPay: 10 },
        { employeeId: "emp-1-missing", netPay: 0 },
        { netPay: 50 },
      ],
      usersById,
    });
    assert.equal(plan.hasBlockingErrors, true);
    assert.ok(plan.blockingIssues.some((issue) => issue.code === "DUPLICATE_RECIPIENT"));
    assert.ok(plan.blockingIssues.some((issue) => issue.code === "INVALID_AMOUNT"));
    assert.ok(plan.blockingIssues.some((issue) => issue.code === "MISSING_EMPLOYEE_ID"));
    assert.ok(plan.blockingIssues.some((issue) => issue.code === "EMPLOYEE_NOT_IN_COMPANY"));
  });

  it("builds a deterministic idempotency key", () => {
    assert.equal(
      buildIdempotencyKey("co-1", "run-1"),
      "bizbuddy:disbursement:co-1:run-1"
    );
    assert.equal(roundMoney(10.005), 10.01);
  });
});

describe("disbursementService", () => {
  it("creates a disbursement from an approved/finalized payroll", async () => {
    const { service, prisma } = createService(defaultSeed());
    const batch = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    assert.equal(batch.status, "READY_FOR_REVIEW");
    assert.equal(batch.recipientCount, 2);
    assert.equal(batch.totalAmount, 1500.5);
    assert.equal(batch.currency, "USD");
    assert.equal(batch.idempotencyKey, "bizbuddy:disbursement:co-1:run-1");
    assert.equal(prisma._db.recipients.length, 2);
    assert.equal(prisma._db.recipients[0].amount, 1000.25);
    assert.ok(prisma._db.audit.some((event) => event.action === "BATCH_CREATED"));
  });

  it("prevents duplicate disbursement creation for an active batch", async () => {
    const { service } = createService(defaultSeed());
    await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await assert.rejects(
      () => service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" }),
      (err) => err instanceof DisbursementError && err.code === "DUPLICATE_DISBURSEMENT"
    );
  });

  it("prevents creation from unapproved or unlocked payroll", async () => {
    const seed = defaultSeed();
    seed.payrollRuns[0].locked = false;
    seed.payrollRuns[0].status = "draft";
    const { service } = createService(seed);
    await assert.rejects(
      () => service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" }),
      (err) => err instanceof DisbursementError && err.code === "PAYROLL_NOT_FINALIZED"
    );
  });

  it("rejects creation when the payroll snapshot is missing", async () => {
    const seed = defaultSeed();
    seed.payrollRuns[0].payrollSnapshot = {};
    const { service } = createService(seed);
    await assert.rejects(
      () => service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" }),
      (err) => err instanceof DisbursementError && err.code === "MISSING_PAYROLL_SNAPSHOT"
    );
  });

  it("snapshots correct recipient amounts and batch total", async () => {
    const { service, prisma } = createService(defaultSeed());
    const batch = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    const total = prisma._db.recipients.reduce((sum, row) => sum + row.amount, 0);
    assert.equal(roundMoney(total), batch.totalAmount);
    assert.deepEqual(
      prisma._db.recipients.map((row) => row.employeeId).sort(),
      ["emp-1", "emp-2"]
    );
  });

  it("enforces authorization for create, view, and approve", async () => {
    const { service } = createService(defaultSeed());
    await assert.rejects(
      () => service.createFromPayrollRun({ ...actor, role: "supervisor", payrollRunId: "run-1" }),
      (err) => err.status === 403
    );
    await assert.rejects(
      () => service.createFromPayrollRun({ ...actor, role: "employee", payrollRunId: "run-1" }),
      (err) => err.status === 403
    );
    await assert.rejects(
      () => service.getSummary({ companyId: "co-1", role: "employee" }),
      (err) => err.status === 403
    );
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await assert.rejects(
      () => service.approveBatch({ ...actor, batchId: created.id }),
      (err) => err.code === "CANNOT_APPROVE_OWN_BATCH"
    );
  });

  it("allows a supervisor to approve a batch they did not create", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    const approved = await service.approveBatch({ ...supervisorActor, batchId: created.id });
    assert.equal(approved.status, "READY_FOR_DISBURSEMENT");
    assert.equal(approved.approvedById, "supervisor-1");
    await assert.rejects(
      () => service.cancelBatch({ ...supervisorActor, batchId: created.id }),
      (err) => err.status === 403
    );
  });

  it("allows a second admin to approve someone else's batch", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    const approved = await service.approveBatch({ ...superActor, batchId: created.id });
    assert.equal(approved.status, "READY_FOR_DISBURSEMENT");
    assert.equal(approved.approvedById, "super-1");
    assert.ok(prisma._db.audit.some((event) => event.action === "BATCH_APPROVED"));
    await assert.rejects(
      () => service.approveBatch({ ...superActor, batchId: created.id }),
      (err) => err.code === "INVALID_STATE_TRANSITION"
    );
  });

  it("prevents modification after approval", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...superActor, batchId: created.id });
    await assert.rejects(
      () =>
        service.updateRecipientAmount({
          companyId: "co-1",
          role: "admin",
          batchId: created.id,
          recipientId: prisma._db.recipients[0].id,
          amount: 1,
        }),
      (err) => err.code === "AMOUNTS_IMMUTABLE"
    );
  });

  it("blocks approval when a recipient has a blocking error", async () => {
    const seed = defaultSeed();
    seed.payrollRuns[0].payrollSnapshot.employees[0].netPay = 0;
    const { service } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await assert.rejects(
      () => service.approveBatch({ ...superActor, batchId: created.id }),
      (err) => err.code === "BLOCKING_RECIPIENTS"
    );
  });

  it("cancels a batch and allows a new active batch afterward", async () => {
    const { service } = createService(defaultSeed());
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    const cancelled = await service.cancelBatch({ ...superActor, batchId: created.id });
    assert.equal(cancelled.status, "CANCELLED");
    const recreated = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    assert.equal(recreated.status, "READY_FOR_REVIEW");
  });

  it("does not mark a batch completed when the provider is unconfigured", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...superActor, batchId: created.id });
    await assert.rejects(
      () => service.submitBatch({ ...superActor, batchId: created.id }),
      (err) => err.code === "PROVIDER_NOT_CONFIGURED" && err.status === 501
    );
    assert.equal(prisma._db.batches[0].status, "READY_FOR_DISBURSEMENT");
    assert.equal(prisma._db.batches[0].providerBatchId, null);
    assert.equal(prisma._db.recipients.every((row) => row.providerTransactionId == null), true);
    assert.equal(prisma._db.audit.some((event) => event.action === "BATCH_SUBMITTED"), false);
  });

  it("records failed recipient handling without inventing Stripe IDs", async () => {
    const failingProvider = {
      name: "test-fail",
      async submitDisbursement() {
        const error = new Error("Recipient payout account rejected");
        error.code = "RECIPIENT_FAILED";
        throw error;
      },
    };
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed, failingProvider);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...superActor, batchId: created.id });
    await assert.rejects(
      () => service.submitBatch({ ...superActor, batchId: created.id }),
      (err) => err.code === "PROVIDER_ERROR"
    );
    assert.equal(prisma._db.batches[0].status, "FAILED");
    assert.equal(prisma._db.batches[0].providerBatchId, null);
    assert.ok(prisma._db.audit.some((event) => event.action === "BATCH_FAILED"));
  });

  it("rejects submitting cancelled or completed batches", async () => {
    const { service } = createService(defaultSeed());
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.cancelBatch({ ...superActor, batchId: created.id });
    await assert.rejects(
      () => service.submitBatch({ ...superActor, batchId: created.id }),
      (err) => err.code === "INVALID_STATE_TRANSITION"
    );
  });

  it("lets a second admin approve, and rejects the approver marking payment sent", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...secondAdmin, batchId: created.id });
    await assert.rejects(
      () =>
        service.markPaymentSent({
          ...secondAdmin,
          batchId: created.id,
          paymentMethod: "CHECK",
          file: paymentProof,
        }),
      (err) => err.code === "CANNOT_MARK_PAID_AS_APPROVER"
    );
  });

  it("requires a screenshot before marking payment sent", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...secondAdmin, batchId: created.id });
    await assert.rejects(
      () =>
        service.markPaymentSent({
          ...actor,
          batchId: created.id,
          paymentMethod: "CHECK",
          file: null,
        }),
      (err) => err.code === "PROOF_REQUIRED"
    );
  });

  it("marks payment sent with proof without inventing Stripe IDs", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...secondAdmin, batchId: created.id });
    const completed = await service.markPaymentSent({
      ...actor,
      batchId: created.id,
      paymentMethod: "CHECK",
      file: paymentProof,
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.paymentMethod, "CHECK");
    assert.equal(completed.paymentProof.hasProof, true);
    assert.equal(prisma._db.batches[0].providerBatchId, null);
    assert.ok(prisma._db.audit.some((event) => event.action === "BATCH_COMPLETED"));
    assert.equal(prisma._db.recipients.every((row) => row.status === "PAID"), true);
    assert.ok(prisma._db.recipients.every((row) => row.paymentProofBytes));
  });

  it("marks payment sent per employee and completes only when all payable recipients are paid", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...secondAdmin, batchId: created.id });
    const first = prisma._db.recipients.find((row) => row.employeeId === "emp-1");
    const second = prisma._db.recipients.find((row) => row.employeeId === "emp-2");

    const afterFirst = await service.markRecipientPaymentSent({
      ...actor,
      batchId: created.id,
      recipientId: first.id,
      paymentMethod: "CHECK",
      file: paymentProof,
    });
    assert.equal(afterFirst.status, "READY_FOR_DISBURSEMENT");
    assert.equal(prisma._db.recipients.find((row) => row.id === first.id).status, "PAID");
    assert.equal(prisma._db.recipients.find((row) => row.id === second.id).status, "READY");

    const otherProof = {
      buffer: Buffer.from("other-proof"),
      mimetype: "image/jpeg",
      originalname: "wire.jpg",
      size: 11,
    };
    const afterSecond = await service.markRecipientPaymentSent({
      ...actor,
      batchId: created.id,
      recipientId: second.id,
      paymentMethod: "BANK_TRANSFER",
      file: otherProof,
    });
    assert.equal(afterSecond.status, "COMPLETED");
    assert.equal(prisma._db.batches[0].providerBatchId, null);
    assert.equal(prisma._db.recipients.find((row) => row.id === first.id).paymentMethod, "CHECK");
    assert.equal(prisma._db.recipients.find((row) => row.id === second.id).paymentMethod, "BANK_TRANSFER");
    assert.ok(prisma._db.audit.some((event) => event.action === "RECIPIENT_STATUS_CHANGED"));
    assert.ok(prisma._db.audit.some((event) => event.action === "BATCH_COMPLETED"));
  });

  it("rejects marking the same employee paid twice, and keeps per-employee proof when marking remaining", async () => {
    const seed = defaultSeed();
    seed.users[0].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_ada" };
    seed.users[1].payrollDetails = { payoutProvider: "stripe", payoutProviderAccountId: "acct_alan" };
    const { service, prisma } = createService(seed);
    const created = await service.createFromPayrollRun({ ...actor, payrollRunId: "run-1" });
    await service.approveBatch({ ...secondAdmin, batchId: created.id });
    const first = prisma._db.recipients.find((row) => row.employeeId === "emp-1");
    await service.markRecipientPaymentSent({
      ...actor,
      batchId: created.id,
      recipientId: first.id,
      paymentMethod: "CHECK",
      file: paymentProof,
    });
    await assert.rejects(
      () =>
        service.markRecipientPaymentSent({
          ...actor,
          batchId: created.id,
          recipientId: first.id,
          paymentMethod: "CASH",
          file: paymentProof,
        }),
      (err) => err.code === "RECIPIENT_ALREADY_PAID"
    );

    const remainingProof = {
      buffer: Buffer.from("remaining-proof"),
      mimetype: "image/webp",
      originalname: "remaining.webp",
      size: 15,
    };
    const completed = await service.markPaymentSent({
      ...actor,
      batchId: created.id,
      paymentMethod: "BANK_TRANSFER",
      file: remainingProof,
    });
    assert.equal(completed.status, "COMPLETED");
    const firstAfter = prisma._db.recipients.find((row) => row.employeeId === "emp-1");
    const secondAfter = prisma._db.recipients.find((row) => row.employeeId === "emp-2");
    assert.equal(firstAfter.paymentMethod, "CHECK");
    assert.equal(String(firstAfter.paymentProofBytes), String(paymentProof.buffer));
    assert.equal(secondAfter.paymentMethod, "BANK_TRANSFER");
    assert.equal(String(secondAfter.paymentProofBytes), String(remainingProof.buffer));
  });
});
