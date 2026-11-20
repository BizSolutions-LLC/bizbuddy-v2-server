// src/services/Features/punchFacePhotoService.js
//
// BB-141: face capture as proof of the punch.
//
// Rules (agreed 2026-11-20):
//   - Applies only while Company.taskReportEnabled is on AND taskReportMode =
//     "forms" AND taskReportFaceCapture is on. Free-form documentation never
//     asks for a photo.
//   - While it applies: every clock-out needs a live photo; every clock-in too
//     when taskReportFaceCaptureClockIn is on. The rule follows the company
//     settings only (no client marker).
//   - While it applies, web (browser) clock-in and clock-out are refused
//     (WEB_PUNCH_DISABLED): the web can't take the photo. Browser = the same
//     user-agent check as BB-134 (utils/punchDeviceProof.punchSource).
//   - The photo is resized (≤ 480 px JPEG, metadata stripped), uploaded to S3
//     under face-photos/<companyId>/<yyyy-mm>/<id>-<kind>.jpg, and one
//     PunchFacePhoto row keeps the key + capture details (phone time, server
//     time, the punch's coordinates, device info).
//   - A required photo that can't be read or uploaded fails the punch: a punch
//     is never saved without its required photo.
//   - Viewing: admins/supervisors in cutoff approvals only, while the punch
//     isn't approved (all its TimeLogApproval rows "approved" = hidden). It is
//     computed on every request, so a revert to pending makes it viewable again.
//     Nothing is deleted on approval; the S3 bucket rule deletes files after
//     90 days.

const crypto = require("crypto");
const sharp = require("sharp");
const { prisma } = require("@config/connection");
const { inspectFacePhoto } = require("@utils/facePhoto");
const { punchSource } = require("@utils/punchDeviceProof");
const s3 = require("@utils/s3");

const MAX_SIDE = 480;
const JPEG_QUALITY = 72;
const S3_RETENTION_DAYS = 90; // bucket lifecycle rule "expire-face-photos"
const LINK_SECONDS = 300;

class FacePhotoError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

async function loadRules(companyId) {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      taskReportEnabled: true, taskReportMode: true,
      taskReportFaceCapture: true, taskReportFaceCaptureClockIn: true,
    },
  });
  const active = Boolean(c?.taskReportEnabled) && c?.taskReportMode === "forms" && Boolean(c?.taskReportFaceCapture);
  return { active, clockIn: active && Boolean(c?.taskReportFaceCaptureClockIn) };
}

/**
 * Called before a punch is written. Throws FacePhotoError when the punch is not
 * allowed (web while face capture applies, or a missing/unreadable photo).
 * Returns { required } — when false, any uploaded file is ignored.
 * @param {"in"|"out"} kind
 */
async function checkPunch(req, kind) {
  const rules = await loadRules(req.user.companyId);
  if (!rules.active) return { required: false };
  if (punchSource(req.headers["user-agent"]) === "web") {
    throw new FacePhotoError(
      403,
      "Clocking in and out on the web is turned off for your company. Please use the mobile app.",
      "WEB_PUNCH_DISABLED"
    );
  }
  const required = kind === "out" || rules.clockIn;
  if (!required) return { required: false };
  const inspected = inspectFacePhoto(req.file);
  if (!inspected.ok) throw new FacePhotoError(400, inspected.message, "FACE_PHOTO_REQUIRED");
  return { required: true };
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resize + upload a required photo. Returns { key, data } where data is the
 * PunchFacePhoto create input without timeLogId (use it as a nested create on
 * the TimeLog so the punch and the row are written together).
 */
async function uploadPhoto({ req, kind, capturedAt, location, deviceInfo }) {
  if (!s3.isConfigured()) {
    throw new FacePhotoError(503, "Face photos can't be saved right now. Please try again later.", "FACE_PHOTO_UNAVAILABLE");
  }

  let out;
  try {
    out = await sharp(req.file.buffer)
      .rotate() // apply the phone's orientation, then metadata (EXIF/GPS) is dropped
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new FacePhotoError(400, "The face photo couldn't be read. Please take it again.", "FACE_PHOTO_REQUIRED");
  }

  const id = crypto.randomUUID();
  const at = capturedAt instanceof Date && !Number.isNaN(capturedAt.getTime()) ? capturedAt : new Date();
  const month = at.toISOString().slice(0, 7);
  const key = `face-photos/${req.user.companyId}/${month}/${id}-${kind}.jpg`;

  try {
    await s3.putObject(key, out.data, "image/jpeg");
  } catch (e) {
    console.error("[BB-141] face photo upload failed:", e.message);
    throw new FacePhotoError(502, "The face photo couldn't be saved. Please try again.", "FACE_PHOTO_UPLOAD_FAILED");
  }

  return {
    key,
    data: {
      id,
      companyId: req.user.companyId,
      userId: req.user.id,
      kind,
      s3Key: key,
      mimeType: "image/jpeg",
      sizeBytes: out.info.size,
      width: out.info.width ?? null,
      height: out.info.height ?? null,
      capturedAt: at,
      latitude: num(location?.latitude),
      longitude: num(location?.longitude),
      accuracy: num(location?.accuracy),
      deviceInfo: deviceInfo && typeof deviceInfo === "object" ? deviceInfo : undefined,
    },
  };
}

/** Best-effort removal of an uploaded file whose punch failed to save. */
function discard(key) {
  if (!key) return;
  s3.deleteObject(key).catch((e) => console.error("[BB-141] face photo cleanup failed:", key, e.message));
}

// ── Viewing (cutoff approvals) ────────────────────────────────────────────────

/** timeLogId → true when every approval row of the punch is "approved". */
async function approvedMap(timeLogIds) {
  const rows = await prisma.timeLogApproval.findMany({
    where: { timeLogId: { in: timeLogIds } },
    select: { timeLogId: true, status: true },
  });
  const byLog = new Map();
  for (const r of rows) {
    const prev = byLog.get(r.timeLogId);
    byLog.set(r.timeLogId, (prev === undefined ? true : prev) && r.status === "approved");
  }
  return byLog;
}

const expired = (p) => Date.now() - new Date(p.capturedAt).getTime() > S3_RETENTION_DAYS * 86400000;

function shapePhoto(p, approved) {
  const isExpired = expired(p);
  return {
    id: p.id,
    kind: p.kind,
    capturedAt: p.capturedAt,
    receivedAt: p.receivedAt,
    latitude: p.latitude,
    longitude: p.longitude,
    accuracy: p.accuracy,
    // why it can't be opened, or null when it can
    unavailable: approved ? "approved" : isExpired ? "expired" : null,
  };
}

/**
 * GET /api/face-photos/cutoff/:cutoffPeriodId[?employeeId=] — the face photos of
 * the punches in a cutoff period, for the cutoff approvals page.
 */
async function listForCutoff(actor, cutoffPeriodId, { employeeId } = {}) {
  const cutoff = await prisma.cutoffPeriod.findFirst({
    where: { id: String(cutoffPeriodId), OR: [{ companyId: actor.companyId }, { creator: { companyId: actor.companyId } }] },
    select: { id: true },
  });
  if (!cutoff) throw new FacePhotoError(404, "Cutoff period not found.");

  const approvals = await prisma.timeLogApproval.findMany({
    where: { cutoffPeriodId: cutoff.id, ...(employeeId && { timeLog: { userId: String(employeeId) } }) },
    select: { timeLogId: true },
  });
  const ids = [...new Set(approvals.map((a) => a.timeLogId))];
  if (!ids.length) return { items: [] };

  const photos = await prisma.punchFacePhoto.findMany({
    where: { companyId: actor.companyId, timeLogId: { in: ids } },
    orderBy: { capturedAt: "asc" },
  });
  if (!photos.length) return { items: [] };

  const approved = await approvedMap([...new Set(photos.map((p) => p.timeLogId))]);
  const byLog = new Map();
  for (const p of photos) {
    const isApproved = approved.get(p.timeLogId) === true;
    const entry = byLog.get(p.timeLogId) || { timeLogId: p.timeLogId, userId: p.userId, approved: isApproved, in: null, out: null };
    entry[p.kind === "in" ? "in" : "out"] = shapePhoto(p, isApproved);
    byLog.set(p.timeLogId, entry);
  }
  return { items: [...byLog.values()] };
}

/** GET /api/face-photos/:id/url — a 5-minute signed link to the image. */
async function photoUrl(actor, photoId) {
  const p = await prisma.punchFacePhoto.findFirst({
    where: { id: String(photoId), companyId: actor.companyId },
  });
  if (!p) throw new FacePhotoError(404, "Face photo not found.");
  const approved = (await approvedMap([p.timeLogId])).get(p.timeLogId) === true;
  if (approved) {
    throw new FacePhotoError(403, "This punch is approved, so its face photo is no longer shown.", "FACE_PHOTO_HIDDEN");
  }
  if (expired(p)) throw new FacePhotoError(410, "This face photo is older than 90 days and was deleted.", "FACE_PHOTO_EXPIRED");
  if (!s3.isConfigured()) throw new FacePhotoError(503, "Face photos can't be shown right now.", "FACE_PHOTO_UNAVAILABLE");
  const url = await s3.signedGetUrl(p.s3Key, LINK_SECONDS);
  return { url, expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString() };
}

module.exports = { FacePhotoError, loadRules, checkPunch, uploadPhoto, discard, listForCutoff, photoUrl };
