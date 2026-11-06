// src/services/Analytics/systemAdminAccountService.js
//
// BB-110: individual system-admin accounts with mandatory authenticator-app
// 2FA. Replaces the single SYSTEM_ADMIN_USERNAME / _PASSWORD env login.
//
// Sign-in is two steps:
//   1. username + password  → short-lived mfaToken (5 min)
//      - first sign-in: also returns a new TOTP secret + otpauth URL to enroll
//   2. mfaToken + 6-digit code (or a recovery code) → 8h session token
//
// Sessions carry tokenVersion; bumping it (logout, password change, 2FA reset,
// deactivation) ends every session of that admin immediately.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("@config/connection");
const ERROR_CODES = require("@constants/errorCodes");
const totp = require("@utils/totp");

const JWT_SECRET = process.env.SYSTEM_ADMIN_JWT_SECRET;
const SESSION_TTL = "8h";
const MFA_TTL = "5m";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const MIN_PASSWORD_LENGTH = 12;

// Compared against when the username doesn't exist, so timing doesn't reveal it.
const DUMMY_HASH = bcrypt.hashSync("bizbuddy-dummy-password", 10);

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function requireSecret() {
  if (!JWT_SECRET) throw httpError(503, "System admin access is not configured.");
}

function publicAdmin(a) {
  return {
    id: a.id,
    username: a.username,
    name: a.name,
    isOwner: a.isOwner,
    active: a.active,
    twoFactorEnabled: Boolean(a.totpEnabledAt),
    twoFactorEnabledAt: a.totpEnabledAt,
    lockedUntil: a.lockedUntil && a.lockedUntil > new Date() ? a.lockedUntil : null,
    lastLoginAt: a.lastLoginAt,
    createdAt: a.createdAt,
  };
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

function hashRecoveryCode(code) {
  const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return crypto.createHash("sha256").update(clean).digest("hex");
}

// 10 codes like "K7PQM-2XRWD"; only their hashes are stored.
function generateRecoveryCodes() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = crypto.randomBytes(10);
    let raw = "";
    for (const b of bytes) raw += alphabet[b % alphabet.length];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

function assertNotLocked(admin) {
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    const err = httpError(429, "Too many failed attempts. Try again in 15 minutes.", ERROR_CODES.ADMIN_LOCKED);
    err.lockedUntil = admin.lockedUntil;
    throw err;
  }
}

async function recordFailure(admin) {
  const attempts = (admin.failedAttempts || 0) + 1;
  await prisma.systemAdmin.update({
    where: { id: admin.id },
    data:
      attempts >= MAX_FAILED_ATTEMPTS
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
        : { failedAttempts: attempts },
  });
}

function signSession(admin) {
  return jwt.sign(
    { role: "system-admin", adminId: admin.id, username: admin.username, tv: admin.tokenVersion },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  );
}

function signMfaToken(admin) {
  return jwt.sign({ purpose: "system-admin-mfa", adminId: admin.id, tv: admin.tokenVersion }, JWT_SECRET, {
    expiresIn: MFA_TTL,
  });
}

// Loads the admin behind an mfaToken, or throws.
async function adminFromMfaToken(mfaToken) {
  requireSecret();
  let decoded;
  try {
    decoded = jwt.verify(String(mfaToken || ""), JWT_SECRET);
  } catch (_) {
    throw httpError(401, "Your sign-in step expired. Please enter your password again.", ERROR_CODES.MFA_TOKEN_INVALID);
  }
  if (decoded.purpose !== "system-admin-mfa") {
    throw httpError(401, "Your sign-in step expired. Please enter your password again.", ERROR_CODES.MFA_TOKEN_INVALID);
  }
  const admin = await prisma.systemAdmin.findUnique({ where: { id: decoded.adminId } });
  if (!admin || !admin.active || admin.tokenVersion !== decoded.tv) {
    throw httpError(401, "Your sign-in step expired. Please enter your password again.", ERROR_CODES.MFA_TOKEN_INVALID);
  }
  assertNotLocked(admin);
  return admin;
}

async function completeSignIn(admin, extraData = {}) {
  const updated = await prisma.systemAdmin.update({
    where: { id: admin.id },
    data: { ...extraData, failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  return { token: signSession(updated), admin: publicAdmin(updated) };
}

// ── Sign-in ────────────────────────────────────────────────────────────────

// Step 1. Returns { mfaRequired, mfaToken } or, before 2FA is set up,
// { mfaSetupRequired, mfaToken, secret, otpauthUrl }.
async function passwordStep({ username, password }) {
  requireSecret();
  const cleanUsername = String(username || "").trim().toLowerCase();
  const admin = cleanUsername ? await prisma.systemAdmin.findUnique({ where: { username: cleanUsername } }) : null;

  if (!admin || !admin.active) {
    await bcrypt.compare(String(password || ""), DUMMY_HASH);
    throw httpError(401, "Invalid credentials", ERROR_CODES.INVALID_CREDENTIALS);
  }
  assertNotLocked(admin);

  if (!(await bcrypt.compare(String(password || ""), admin.passwordHash))) {
    await recordFailure(admin);
    throw httpError(401, "Invalid credentials", ERROR_CODES.INVALID_CREDENTIALS);
  }

  if (admin.totpEnabledAt && admin.totpSecret) {
    return { mfaRequired: true, mfaToken: signMfaToken(admin) };
  }

  // First sign-in (or after a 2FA reset): enroll an authenticator app.
  const secret = totp.generateSecret();
  await prisma.systemAdmin.update({ where: { id: admin.id }, data: { totpPendingSecret: secret } });
  return {
    mfaSetupRequired: true,
    mfaToken: signMfaToken(admin),
    secret,
    otpauthUrl: totp.otpauthUrl({ secret, accountName: admin.username }),
  };
}

// Step 2a. Enrollment: confirm the first code → 2FA on, recovery codes shown once.
async function confirmSetup({ mfaToken, code }) {
  const admin = await adminFromMfaToken(mfaToken);
  if (admin.totpEnabledAt) throw httpError(409, "Two-factor authentication is already set up. Sign in with your code.");
  if (!admin.totpPendingSecret) throw httpError(401, "Your sign-in step expired. Please enter your password again.", ERROR_CODES.MFA_TOKEN_INVALID);

  const step = totp.verifyCode(admin.totpPendingSecret, code);
  if (step === null) {
    await recordFailure(admin);
    throw httpError(401, "That code didn't match. Check your authenticator app and try again.", ERROR_CODES.MFA_INVALID_CODE);
  }

  const { codes, hashes } = generateRecoveryCodes();
  const session = await completeSignIn(admin, {
    totpSecret: admin.totpPendingSecret,
    totpPendingSecret: null,
    totpEnabledAt: new Date(),
    lastTotpStep: step,
    recoveryCodes: hashes,
  });
  return { ...session, recoveryCodes: codes };
}

// Step 2b. Normal sign-in: 6-digit code, or one recovery code (used up on use).
async function verifyStep({ mfaToken, code, recoveryCode }) {
  const admin = await adminFromMfaToken(mfaToken);
  if (!admin.totpEnabledAt || !admin.totpSecret) {
    throw httpError(401, "Your sign-in step expired. Please enter your password again.", ERROR_CODES.MFA_TOKEN_INVALID);
  }

  if (recoveryCode) {
    const hash = hashRecoveryCode(recoveryCode);
    const remaining = Array.isArray(admin.recoveryCodes) ? admin.recoveryCodes : [];
    if (!remaining.includes(hash)) {
      await recordFailure(admin);
      throw httpError(401, "That recovery code isn't valid or was already used.", ERROR_CODES.MFA_INVALID_CODE);
    }
    const left = remaining.filter((h) => h !== hash);
    const session = await completeSignIn(admin, { recoveryCodes: left });
    return { ...session, recoveryCodesRemaining: left.length };
  }

  const step = totp.verifyCode(admin.totpSecret, code, { afterStep: admin.lastTotpStep });
  if (step === null) {
    await recordFailure(admin);
    throw httpError(401, "That code didn't match. Check your authenticator app and try again.", ERROR_CODES.MFA_INVALID_CODE);
  }
  const session = await completeSignIn(admin, { lastTotpStep: step });
  return { ...session, recoveryCodesRemaining: (admin.recoveryCodes || []).length };
}

// Used by the verifySystemAdmin middleware. Returns the admin or null.
async function adminFromSession(token) {
  if (!JWT_SECRET || !token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
  if (decoded.role !== "system-admin" || !decoded.adminId) return null;
  const admin = await prisma.systemAdmin.findUnique({ where: { id: decoded.adminId } });
  if (!admin || !admin.active || !admin.totpEnabledAt || admin.tokenVersion !== decoded.tv) return null;
  return admin;
}

// ── Self-service ───────────────────────────────────────────────────────────

async function logout(adminId) {
  await prisma.systemAdmin.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } });
}

// Ends every session, including this one — the admin signs in again.
async function changeOwnPassword(adminId, { currentPassword, newPassword }) {
  const admin = await prisma.systemAdmin.findUnique({ where: { id: adminId } });
  if (!(await bcrypt.compare(String(currentPassword || ""), admin.passwordHash))) {
    throw httpError(401, "Current password is incorrect.", ERROR_CODES.INVALID_CREDENTIALS);
  }
  validatePassword(newPassword);
  await prisma.systemAdmin.update({
    where: { id: adminId },
    data: { passwordHash: await bcrypt.hash(newPassword, 10), tokenVersion: { increment: 1 } },
  });
}

// Needs a current authenticator code; old recovery codes stop working.
async function regenerateRecoveryCodes(adminId, { code }) {
  const admin = await prisma.systemAdmin.findUnique({ where: { id: adminId } });
  const step = totp.verifyCode(admin.totpSecret, code, { afterStep: admin.lastTotpStep });
  if (step === null) {
    throw httpError(401, "That code didn't match. Check your authenticator app and try again.", ERROR_CODES.MFA_INVALID_CODE);
  }
  const { codes, hashes } = generateRecoveryCodes();
  await prisma.systemAdmin.update({ where: { id: adminId }, data: { recoveryCodes: hashes, lastTotpStep: step } });
  return { recoveryCodes: codes };
}

// ── Owner: manage admins ───────────────────────────────────────────────────

async function listAdmins() {
  const admins = await prisma.systemAdmin.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
  return admins.map(publicAdmin);
}

async function createAdmin({ username, name, password, isOwner }) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(cleanUsername) || !String(name || "").trim()) {
    throw httpError(400, "username (3–40 letters, digits, dots, dashes or underscores) and name are required.");
  }
  validatePassword(password);
  if (await prisma.systemAdmin.findUnique({ where: { username: cleanUsername } })) {
    throw httpError(409, `Username ${cleanUsername} is already taken.`);
  }
  const admin = await prisma.systemAdmin.create({
    data: {
      username: cleanUsername,
      name: String(name).trim(),
      passwordHash: await bcrypt.hash(password, 10),
      isOwner: isOwner === true || isOwner === "true",
    },
  });
  return publicAdmin(admin);
}

async function loadTarget(id) {
  const admin = await prisma.systemAdmin.findUnique({ where: { id } });
  if (!admin) throw httpError(404, "System admin not found.");
  return admin;
}

async function activeOwnerCount(excludeId) {
  return prisma.systemAdmin.count({ where: { isOwner: true, active: true, id: { not: excludeId } } });
}

// Body: { name?, active?, isOwner? }. Deactivating ends their sessions.
async function updateAdmin(actor, id, { name, active, isOwner }) {
  const target = await loadTarget(id);
  const data = {};
  if (name !== undefined) {
    if (!String(name).trim()) throw httpError(400, "name can't be empty.");
    data.name = String(name).trim();
  }
  if (active !== undefined) {
    const value = active === true || active === "true";
    if (!value && target.id === actor.id) throw httpError(400, "You can't deactivate your own account.");
    data.active = value;
    if (!value) data.tokenVersion = { increment: 1 };
    if (value) {
      data.failedAttempts = 0;
      data.lockedUntil = null;
    }
  }
  if (isOwner !== undefined) {
    const value = isOwner === true || isOwner === "true";
    if (!value && target.id === actor.id) throw httpError(400, "You can't remove your own owner role.");
    data.isOwner = value;
  }
  const losingOwner = target.isOwner && (data.isOwner === false || data.active === false);
  if (losingOwner && (await activeOwnerCount(target.id)) === 0) {
    throw httpError(400, "At least one active owner is required.");
  }
  const updated = await prisma.systemAdmin.update({ where: { id }, data });
  return publicAdmin(updated);
}

// Lost phone: clears 2FA; they enroll again at next sign-in. Ends their sessions.
async function resetAdmin2fa(actor, id) {
  const target = await loadTarget(id);
  if (target.id === actor.id) throw httpError(400, "Ask another owner to reset your two-factor authentication.");
  const updated = await prisma.systemAdmin.update({
    where: { id },
    data: {
      totpSecret: null,
      totpPendingSecret: null,
      totpEnabledAt: null,
      lastTotpStep: null,
      recoveryCodes: [],
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
  return publicAdmin(updated);
}

// Forgotten password: owner sets a temporary one. Ends their sessions.
async function resetAdminPassword(actor, id, { password }) {
  const target = await loadTarget(id);
  if (target.id === actor.id) throw httpError(400, "Use Change password for your own account.");
  validatePassword(password);
  const updated = await prisma.systemAdmin.update({
    where: { id },
    data: {
      passwordHash: await bcrypt.hash(password, 10),
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
  return publicAdmin(updated);
}

module.exports = {
  publicAdmin,
  passwordStep,
  confirmSetup,
  verifyStep,
  adminFromSession,
  logout,
  changeOwnPassword,
  regenerateRecoveryCodes,
  listAdmins,
  createAdmin,
  updateAdmin,
  resetAdmin2fa,
  resetAdminPassword,
  MIN_PASSWORD_LENGTH,
};
