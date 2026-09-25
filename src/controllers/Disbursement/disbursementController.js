"use strict";

const {
  getDefaultDisbursementService,
} = require("@services/Disbursement/disbursementService");
const { DisbursementError } = require("@services/Disbursement/disbursementErrors");

const service = getDefaultDisbursementService();

function actorFromRequest(req) {
  return {
    companyId: req.user.companyId,
    actorUserId: req.user.id,
    role: req.user.role,
  };
}

function handleError(res, error, context) {
  if (error instanceof DisbursementError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
  console.error(`Disbursement ${context}:`, error);
  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
}

exports.getSummary = async (req, res) => {
  try {
    const { companyId, role } = actorFromRequest(req);
    const data = await service.getSummary({ companyId, role });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "getSummary");
  }
};

exports.listBatches = async (req, res) => {
  try {
    const { companyId, role } = actorFromRequest(req);
    const data = await service.listBatches({
      companyId,
      role,
      payrollRunId: req.query.payrollRunId,
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "listBatches");
  }
};

exports.getBatch = async (req, res) => {
  try {
    const { companyId, role } = actorFromRequest(req);
    const data = await service.getBatch({
      companyId,
      role,
      batchId: req.params.id,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "getBatch");
  }
};

exports.createFromPayrollRun = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.createFromPayrollRun({
      companyId,
      actorUserId,
      role,
      payrollRunId: req.params.payrollRunId,
    });
    return res.status(201).json({
      success: true,
      message: "Disbursement batch created from finalized payroll.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "createFromPayrollRun");
  }
};

exports.approveBatch = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.approveBatch({
      companyId,
      actorUserId,
      role,
      batchId: req.params.id,
    });
    return res.status(200).json({
      success: true,
      message: "Disbursement batch approved.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "approveBatch");
  }
};

exports.cancelBatch = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.cancelBatch({
      companyId,
      actorUserId,
      role,
      batchId: req.params.id,
    });
    return res.status(200).json({
      success: true,
      message: "Disbursement batch cancelled.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "cancelBatch");
  }
};

exports.submitBatch = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.submitBatch({
      companyId,
      actorUserId,
      role,
      batchId: req.params.id,
    });
    return res.status(200).json({
      success: true,
      message: "Disbursement batch submitted.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "submitBatch");
  }
};

exports.markPaymentSent = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.markPaymentSent({
      companyId,
      actorUserId,
      role,
      batchId: req.params.id,
      paymentMethod: req.body?.paymentMethod,
      file: req.file,
    });
    return res.status(200).json({
      success: true,
      message: "Payment marked as sent with proof attached.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "markPaymentSent");
  }
};

exports.markRecipientPaymentSent = async (req, res) => {
  try {
    const { companyId, actorUserId, role } = actorFromRequest(req);
    const data = await service.markRecipientPaymentSent({
      companyId,
      actorUserId,
      role,
      batchId: req.params.id,
      recipientId: req.params.recipientId,
      paymentMethod: req.body?.paymentMethod,
      file: req.file,
    });
    return res.status(200).json({
      success: true,
      message: "Employee payment marked as sent with proof attached.",
      data,
    });
  } catch (error) {
    return handleError(res, error, "markRecipientPaymentSent");
  }
};

function sendProof(res, proof) {
  res.setHeader("Content-Type", proof.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${String(proof.fileName).replace(/"/g, "")}"`
  );
  return res.status(200).send(proof.bytes);
}

exports.getPaymentProof = async (req, res) => {
  try {
    const { companyId, role } = actorFromRequest(req);
    const proof = await service.getPaymentProof({
      companyId,
      role,
      batchId: req.params.id,
    });
    return sendProof(res, proof);
  } catch (error) {
    return handleError(res, error, "getPaymentProof");
  }
};

exports.getRecipientPaymentProof = async (req, res) => {
  try {
    const { companyId, role } = actorFromRequest(req);
    const proof = await service.getRecipientPaymentProof({
      companyId,
      role,
      batchId: req.params.id,
      recipientId: req.params.recipientId,
    });
    return sendProof(res, proof);
  } catch (error) {
    return handleError(res, error, "getRecipientPaymentProof");
  }
};
