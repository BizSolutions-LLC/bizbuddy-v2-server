// src/controllers/Account/accountSigninController.js

const { prisma } = require("@config/connection");
const { JWT_SECRET } = require("@config/env");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  getNormalizedDeviceId,
  parseReplaceDevice,
  getRegisteredDeviceConflict,
  shouldBumpTokenVersionOnDeviceSwitch,
  buildSignInUpdateData,
  shouldBumpTokenVersionOnSignOut,
} = require("@utils/mobileDeviceLogin");
const ERROR_CODES = require("@constants/errorCodes");
const { checkAgentAccess } = require("@utils/systemAgent");

// BB-110: sign-in has no Bearer token yet, so requestLogger would record it as
// anonymous. Tag its context (same object it logs from) so B. Buddy sign-ins
// and failed PIN attempts show up in the monitoring trail.
function tagSystemAgentRequest(req, user, agentId) {
  if (!req.userContext) return;
  Object.assign(req.userContext, {
    userId: user.id,
    companyId: user.companyId,
    isSystemAgent: true,
    agentId: agentId || null,
  });
}

// BB-110: 5 wrong PINs in a row locks the staff code for 15 minutes.
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

async function recordWrongPin(agent) {
  const attempts = (agent.failedPinAttempts || 0) + 1;
  await prisma.supportAgent.update({
    where: { id: agent.id },
    data:
      attempts >= PIN_MAX_ATTEMPTS
        ? { failedPinAttempts: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) }
        : { failedPinAttempts: attempts },
  });
}

const getUserEmail = async (req, res) => {
  console.log("## Check User Email and Retrieved Company");
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const users = await prisma.user.findMany({
      where: {
        email: normalizedEmail,
        status: "active",
      },
      include: { company: { select: { id: true, name: true } } },
    });

    const result = users.map((user) => ({
      userId: user.id,
      email: user.email,
      username: user.username,
      companyId: user.companyId,
      companyName: user.company ? user.company.name : null,
      role: user.role,
      status: user.status,
      // BB-110: B. Buddy keeps role=admin for access; the picker shows it as "Internal"
      isSystemAgent: user.isSystemAgent,
    }));

    console.log("## Success");
    return res.status(200).json({
      message: users.length > 0 ? "Users found." : "No active accounts found for this email.",
      data: result,
      hasActiveAccounts: users.length > 0,
    });
  } catch (error) {
    console.error("Error in getUserEmail:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getUserProfile = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "No token provided." });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Invalid token." });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid token." });
    }
    const { userId, companyId } = decoded;
    if (!userId || !companyId) {
      return res.status(400).json({ message: "Token missing userId or companyId." });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        company: true,
        employmentDetail: {
          include: {
            department: true,
            supervisor: { select: { id: true, email: true } },
          },
        },
        Subscription: {
          where: { active: true },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { plan: true },
        },
      },
    });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (
      decoded.tokenVersion != null &&
      user.tokenVersion !== decoded.tokenVersion
    ) {
      return res.status(401).json({
        message: "Session ended. Please sign in again.",
        code: "TOKEN_VERSION_MISMATCH",
      });
    }

    let latestSubscription =
      user.Subscription && user.Subscription.length > 0 ? user.Subscription[0] : null;
    if (!latestSubscription) {
      const companyWithSub = await prisma.company.findUnique({
        where: { id: companyId },
        include: {
          Subscription: {
            where: { active: true },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { plan: true },
          },
        },
      });
      latestSubscription =
        companyWithSub &&
        companyWithSub.Subscription &&
        companyWithSub.Subscription.length > 0
          ? companyWithSub.Subscription[0]
          : null;
    }
    const { password, Subscription, ...userData } = user;
    // lastLoginAt is already on userData via spread
    return res.status(200).json({
      message: "User profile retrieved successfully.",
      data: {
        user: userData,
        profile: user.profile,
        company: user.company,
        subscription: latestSubscription,
      },
    });
  } catch (error) {
    console.error("Error in getUserProfile:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const signIn = async (req, res) => {
  console.log("## Signin Start");
  try {
    // Support both legacy GET (query params) and new POST (request body)
    const { email, password, companyId, deviceId, replaceDevice, agentCode, agentPin } = {
      ...req.query,
      ...req.body,
    };

    if (!email || !password || !companyId) {
      return res.status(400).json({
        message: "Email, password, and companyId are required.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail, companyId },
      include: { company: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (user.status !== "active") {
      return res.status(403).json({
        message: "Account is inactive. Please contact your administrator.",
      });
    }

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      if (user.isSystemAgent) tagSystemAgentRequest(req, user, null);
      return res.status(401).json({ message: "Invalid credentials." });
    }

    // BB-110: B. Buddy is shared by support staff — each must identify with
    // their own code + PIN so the audit trail knows who was behind the login.
    let supportAgent = null;
    if (user.isSystemAgent) {
      tagSystemAgentRequest(req, user, null);
      if (!agentCode || !agentPin) {
        return res.status(401).json({
          message: "Enter your staff code and PIN to continue as B. Buddy.",
          code: ERROR_CODES.AGENT_IDENTITY_REQUIRED,
        });
      }
      supportAgent = await prisma.supportAgent.findUnique({
        where: { code: String(agentCode).trim().toUpperCase() },
      });
      if (supportAgent && supportAgent.pinLockedUntil && supportAgent.pinLockedUntil > new Date()) {
        tagSystemAgentRequest(req, user, supportAgent.id);
        return res.status(429).json({
          message: "Too many wrong PINs. This staff code is locked for 15 minutes — or ask a system admin to reset your PIN.",
          code: ERROR_CODES.AGENT_LOCKED,
          lockedUntil: supportAgent.pinLockedUntil,
        });
      }
      const pinValid =
        supportAgent && supportAgent.active && !supportAgent.archivedAt
          ? await bcrypt.compare(String(agentPin), supportAgent.pinHash)
          : false;
      if (!pinValid) {
        if (supportAgent) {
          tagSystemAgentRequest(req, user, supportAgent.id);
          await recordWrongPin(supportAgent);
        }
        return res.status(401).json({
          message: "Invalid staff code or PIN.",
          code: ERROR_CODES.AGENT_IDENTITY_INVALID,
        });
      }
      const access = await checkAgentAccess(supportAgent.id, user.companyId);
      if (!access.ok) {
        tagSystemAgentRequest(req, user, supportAgent.id);
        return res.status(403).json({
          message: "You're not assigned to this company. Ask a BizBuddy system admin for access.",
          code: ERROR_CODES.AGENT_NOT_ASSIGNED,
        });
      }
    }

    // Mobile sends deviceId; web omits it and keeps existing behavior.
    // B. Buddy skips the single-device lock entirely: several staff share the
    // account, so registering one phone would lock out (or sign out) the rest.
    const normalizedDeviceId = user.isSystemAgent ? "" : getNormalizedDeviceId(deviceId);
    const replaceRegisteredDevice = parseReplaceDevice(replaceDevice);
    const deviceConflict = getRegisteredDeviceConflict(
      user,
      normalizedDeviceId,
      replaceRegisteredDevice
    );
    if (deviceConflict) {
      console.warn("[SignIn] Device conflict", {
        userId: user.id,
        email: normalizedEmail,
        companyId,
        registeredDeviceId: user.registeredDeviceId ?? null,
        registeredDeviceAt: user.registeredDeviceAt ?? null,
        requestDeviceId: normalizedDeviceId,
        replaceDevice: replaceRegisteredDevice,
        switchAllowedAt: deviceConflict.switchAllowedAt ?? null,
      });
      return res.status(deviceConflict.status).json({
        message: deviceConflict.message,
        code: deviceConflict.code,
        registeredDeviceId: user.registeredDeviceId ?? null,
        requestDeviceId: normalizedDeviceId,
        replaceDeviceAccepted: replaceRegisteredDevice,
        switchAllowedAt: deviceConflict.switchAllowedAt ?? null,
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: buildSignInUpdateData(normalizedDeviceId, {
        bumpTokenVersion: shouldBumpTokenVersionOnDeviceSwitch(
          user,
          normalizedDeviceId,
          replaceRegisteredDevice
        ),
      }),
    });

    if (!JWT_SECRET) {
      return res.status(500).json({ message: "JWT secret is not configured." });
    }

    // tokenVersion revokes sessions (logout-all, device switch). No JWT exp — avoids
    // clock-out/API failures while the app still shows a saved session after 30 days.
    const tokenPayload = {
      userId: user.id,
      companyId: user.companyId,
      tokenVersion: updatedUser.tokenVersion,
    };
    if (supportAgent) {
      tagSystemAgentRequest(req, user, supportAgent.id);
      tokenPayload.isSystemAgent = true;
      tokenPayload.agentId = supportAgent.id;
      await prisma.supportAgent.update({
        where: { id: supportAgent.id },
        data: { lastUsedAt: new Date(), failedPinAttempts: 0, pinLockedUntil: null },
      });
    }
    const token = jwt.sign(tokenPayload, JWT_SECRET);

    console.log("## Success");
    return res.status(200).json({
      message: "Sign-in successful.",
      data: {
        token,
        lastLoginAt: user.lastLoginAt, // previous session's last login (before this one)
      },
    });
  } catch (error) {
    console.error("Error in signIn:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const signOut = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { deviceId } = { ...req.query, ...req.body };
    const normalizedDeviceId = getNormalizedDeviceId(deviceId);

    // Mobile sign-out is client-side session clear only (keeps registeredDeviceId for
    // cooldown). Do not bump tokenVersion — biometric reuses the same JWT on this device.
    // POST /account/logout-all still revokes all sessions when needed.
    if (shouldBumpTokenVersionOnSignOut(normalizedDeviceId)) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          tokenVersion: { increment: 1 },
        },
      });
    }

    return res.status(200).json({ message: "Signed out successfully." });
  } catch (error) {
    console.error("Error in signOut:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { id: userId, companyId } = req.user;
    let {
      username,
      email,
      firstName,
      lastName,
      phoneNumber,
      ssnItin,
      dateOfBirth,
      addressLine,
      city,
      state,
      postalCode,
      emergencyContactName,
      emergencyContactPhone,
    } = req.body;

    console.log(req.body);

    if (!username || !email) {
      return res.status(400).json({ message: "Username and email are required." });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const normalizedEmail = email.trim().toLowerCase();

    if (normalizedUsername.length < 3) {
      return res.status(400).json({ message: "Username must be at least 3 characters." });
    }

    if (!/^[a-z0-9]([a-z0-9._]*[a-z0-9])?$/i.test(normalizedUsername)) {
      return res.status(400).json({
        message:
          "Username must start and end with a letter or number. Only letters, numbers, periods (.) and underscores (_) are allowed.",
      });
    }

    if (/[._]{2,}/.test(normalizedUsername)) {
      return res.status(400).json({
        message: "Username cannot contain consecutive periods or underscores.",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    const duplicateUsername = await prisma.user.findFirst({
      where: {
        username: { equals: normalizedUsername, mode: "insensitive" },
        NOT: { id: userId },
      },
    });
    if (duplicateUsername) {
      return res.status(400).json({ message: "Username is already taken." });
    }

    const duplicateEmail = await prisma.user.findFirst({
      where: {
        companyId,
        email: normalizedEmail,
        NOT: { id: userId },
      },
    });
    if (duplicateEmail) {
      return res.status(400).json({ message: "Email already exists within the company." });
    }

    let normalizedSsnItin = null;
    if (ssnItin && ssnItin.trim()) {
      normalizedSsnItin = ssnItin.trim();
      if (normalizedSsnItin.length < 9 || normalizedSsnItin.length > 15) {
        return res.status(400).json({
          message: "SSN/ITIN must be between 9 and 15 characters.",
        });
      }
      const duplicateSsn = await prisma.userProfile.findFirst({
        where: { ssnItin: normalizedSsnItin, NOT: { userId } },
      });
      if (duplicateSsn) {
        return res.status(400).json({
          message: "SSN/ITIN is already associated with another employee.",
        });
      }
    }

    let parsedDateOfBirth = null;
    if (dateOfBirth && dateOfBirth.trim()) {
      parsedDateOfBirth = new Date(dateOfBirth);
      if (isNaN(parsedDateOfBirth.getTime())) {
        return res.status(400).json({ message: "Please enter a valid date of birth." });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        username: normalizedUsername,
        email: normalizedEmail,
        updatedAt: new Date(),
      },
    });

    const profileData = {
      firstName: firstName?.trim() || null,
      lastName: lastName?.trim() || null,
      phoneNumber: phoneNumber?.trim() || null,
      ssnItin: normalizedSsnItin,
      dateOfBirth: parsedDateOfBirth,
      addressLine: addressLine?.trim() || null,
      city: city?.trim() || null,
      state: state?.trim() || null,
      postalCode: postalCode?.trim() || null,
      emergencyContactName: emergencyContactName?.trim() || null,
      emergencyContactPhone: emergencyContactPhone?.trim() || null,
      email: normalizedEmail,
      username: normalizedUsername,
      updatedAt: new Date(),
    };

    const updatedProfile = await prisma.userProfile.upsert({
      where: { userId },
      update: profileData,
      create: { userId, ...profileData },
    });

    return res.status(200).json({
      message: "Profile updated successfully.",
      data: { user: updatedUser, profile: updatedProfile },
    });
  } catch (error) {
    console.error("Error in updateProfile:", error);
    if (error.code === "P2002") {
      const field = error.meta?.target?.[0];
      if (field === "username") {
        return res.status(400).json({ message: "Username is already taken." });
      }
      if (field === "ssnItin") {
        return res.status(400).json({
          message: "SSN/ITIN is already associated with another employee.",
        });
      }
    }
    return res.status(500).json({ message: "Internal server error." });
  }
};

const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All password fields are required." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "New password and confirmation do not match." });
    }
    const { id: userId } = req.user;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Old password is incorrect." });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
    return res.status(200).json({ message: "Password changed successfully." });
  } catch (error) {
    console.error("Error in changePassword:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getDeviceToken = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required." });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deviceToken: true },
    });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.status(200).json({
      message: "Device token retrieved successfully.",
      data: { deviceToken: user.deviceToken },
    });
  } catch (error) {
    console.error("Error in getDeviceToken:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const updateDeviceToken = async (req, res) => {
  try {
    const { userId, deviceToken } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required." });
    }
    if (!deviceToken) {
      return res.status(400).json({ message: "Device token is required." });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    // BB-110: B. Buddy gets no push notifications — don't store a (shared) FCM token.
    if (user.isSystemAgent) {
      return res.status(200).json({
        message: "Device token not stored for the B. Buddy account.",
        data: { deviceToken: null },
      });
    }
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { deviceToken: deviceToken.trim(), updatedAt: new Date() },
    });
    return res.status(200).json({
      message: "Device token updated successfully.",
      data: { deviceToken: updatedUser.deviceToken },
    });
  } catch (error) {
    console.error("Error in updateDeviceToken:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getUserExportData = async (req, res) => {
  try {
    const { userId, companyId } = req.query;
    if (!userId || !companyId) {
      return res.status(400).json({ success: false, message: "userId and companyId are required" });
    }
    console.log("📊 Export data request for userId:", userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        companyId: true,
        profile: { select: { firstName: true, lastName: true } },
        company: { select: { name: true } },
      },
    });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.companyId !== companyId) {
      console.warn("⚠️ Company ID mismatch:", {
        userCompanyId: user.companyId,
        requestedCompanyId: companyId,
      });
      return res.status(403).json({ success: false, message: "Company ID mismatch" });
    }
    const fullName =
      user.profile
        ? `${user.profile.firstName || ""} ${user.profile.lastName || ""}`.trim() || user.email
        : user.email;
    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullName,
        company: { name: user.company?.name || "Company" },
      },
    });
  } catch (error) {
    console.error("❌ Error in getUserExportData:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

module.exports = {
  getUserEmail,
  signIn,
  getUserProfile,
  updateProfile,
  changePassword,
  signOut,
  getDeviceToken,
  updateDeviceToken,
  getUserExportData
};
