"use strict";

const express = require("express");
const multer = require("multer");
const router = express.Router();
const authenticate = require("@middlewares/authMiddleware");
const { authorizeRoles } = require("@middlewares/roleMiddleware");
const {
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
} = require("@controllers/Disbursement/disbursementController");

const canView = [authenticate, authorizeRoles("admin", "supervisor", "superadmin")];
const canCreate = [authenticate, authorizeRoles("admin", "superadmin")];
const canApprove = [authenticate, authorizeRoles("admin", "supervisor", "superadmin")];

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get("/summary", ...canView, getSummary);
router.get("/", ...canView, listBatches);
router.get("/:id/payment-proof", ...canView, getPaymentProof);
router.get("/:id/recipients/:recipientId/payment-proof", ...canView, getRecipientPaymentProof);
router.get("/:id", ...canView, getBatch);
router.post("/from-payroll-run/:payrollRunId", ...canCreate, createFromPayrollRun);
router.post("/:id/approve", ...canApprove, approveBatch);
router.post("/:id/cancel", ...canCreate, cancelBatch);
router.post("/:id/submit", ...canCreate, submitBatch);
router.post(
  "/:id/mark-paid",
  ...canCreate,
  proofUpload.single("proof"),
  markPaymentSent
);
router.post(
  "/:id/recipients/:recipientId/mark-paid",
  ...canCreate,
  proofUpload.single("proof"),
  markRecipientPaymentSent
);

module.exports = router;
