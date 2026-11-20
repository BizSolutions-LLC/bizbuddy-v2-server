// src/utils/punchDeviceProof.js
//
// BB-134: server-written proof on each clock-in / clock-out.
//
// The client asked for the phone's MAC address. Phones don't expose it any more
// (iOS returns 02:00:00:00:00:00, Android 10+ randomises it per Wi-Fi network,
// browsers can't read it). This records what the MAC was meant to prove: which
// device sent the punch, whether it is the employee's registered phone, and when
// the server actually received it, written by the server, never by the client.
//
// Only recorded when Company.punchDeviceProofEnabled is on. Optional: a missing
// deviceId or a mismatch never blocks or changes the punch, and nothing in hours,
// approvals or payroll reads it.

const { getNormalizedDeviceId } = require("@utils/mobileDeviceLogin");

// Same web-vs-app rule as services/Analytics/userActivityService.js (CLIENT_KIND).
function punchSource(userAgent) {
  if (!userAgent) return "other";
  if (/(okhttp|cfnetwork|darwin|expo|reactnative|dart)/i.test(userAgent)) return "app";
  if (/^mozilla/i.test(userAgent)) return "web";
  return "other";
}

// req.ip honours app's "trust proxy" setting; raw X-Forwarded-For is client-controlled.
// Same rule as middlewares/requestLogger.js getClientIp.
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Builds the proof for one punch.
 * @param {object} req          Express request (body.deviceId, user-agent, ip)
 * @param {string|null} registeredDeviceId  User.registeredDeviceId at punch time
 */
function buildPunchProof(req, registeredDeviceId) {
  const deviceId = getNormalizedDeviceId(req.body?.deviceId) || null;
  const registered = registeredDeviceId || null;
  const userAgent = req.headers?.["user-agent"] || null;
  return {
    deviceId,
    registeredDeviceId: registered,
    // null = nothing to compare (web punch, app didn't send an ID, or no phone registered yet)
    deviceMatch: deviceId && registered ? deviceId === registered : null,
    serverReceivedAt: new Date().toISOString(),
    ipAddress: clientIp(req),
    userAgent,
    source: punchSource(userAgent),
  };
}

/**
 * Returns the deviceInfo side ({start} or {end}) to store.
 * Any client-sent `proof` key is always dropped, so a client can't fake one.
 * With proof === null (toggle off) the client's value is stored as before.
 */
function withPunchProof(clientDeviceInfo, proof) {
  const isObject =
    clientDeviceInfo != null && typeof clientDeviceInfo === "object" && !Array.isArray(clientDeviceInfo);

  if (isObject) {
    const { proof: _ignored, ...rest } = clientDeviceInfo;
    return proof ? { ...rest, proof } : rest;
  }
  if (!proof) return clientDeviceInfo ?? null;
  // Non-object device info (e.g. a plain string) is kept under `value`.
  return clientDeviceInfo != null ? { value: clientDeviceInfo, proof } : { proof };
}

/**
 * Loads the company toggle + the user's registered phone in one query and
 * returns the proof, or null when the company has it off.
 */
async function resolvePunchProof(prisma, req, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      registeredDeviceId: true,
      company: { select: { punchDeviceProofEnabled: true } },
    },
  });
  if (!user?.company?.punchDeviceProofEnabled) return null;
  return buildPunchProof(req, user.registeredDeviceId);
}

module.exports = { buildPunchProof, withPunchProof, resolvePunchProof, punchSource };
