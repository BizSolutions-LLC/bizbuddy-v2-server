// src/controllers/Features/punchFacePhotoController.js
//
// BB-141: face photos for the cutoff approvals page (admin / supervisor).
//   GET /api/face-photos/cutoff/:cutoffPeriodId[?employeeId=]
//   GET /api/face-photos/:id/url

const { listForCutoff, photoUrl, FacePhotoError } = require("@services/Features/punchFacePhotoService");

const send = (res, err, label) => {
  if (err instanceof FacePhotoError)
    return res.status(err.status).json({ message: err.message, ...(err.code && { code: err.code }) });
  console.error(`[BB-141] ${label} error:`, err);
  return res.status(500).json({ message: "Failed to load face photos." });
};

const getCutoffFacePhotos = async (req, res) => {
  try {
    return res.json({ data: await listForCutoff(req.user, req.params.cutoffPeriodId, req.query) });
  } catch (err) {
    return send(res, err, "getCutoffFacePhotos");
  }
};

const getFacePhotoUrl = async (req, res) => {
  try {
    return res.json({ data: await photoUrl(req.user, req.params.id) });
  } catch (err) {
    return send(res, err, "getFacePhotoUrl");
  }
};

module.exports = { getCutoffFacePhotos, getFacePhotoUrl };
