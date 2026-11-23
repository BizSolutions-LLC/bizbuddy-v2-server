// src/controllers/Account/resetPasswordController.js

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { sendMail } = require("@utils/mailer"); // BB-140
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { renderEmail, links } = require("@emails/renderEmail"); // BB-144
const { fmtDateTime, fmtDuration } = require("@emails/emailFormat");
const { describeDevice } = require("@utils/describeDevice");

// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------

// BB-140: emails go through utils/mailer.sendMail (same SMTP account), so they are logged.


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure raw token.
 * The RAW token is sent to the user; only the HASH is stored in the DB.
 */
const generateResetToken = () => crypto.randomBytes(32).toString("hex");

/**
 * Hash a raw token with SHA-256 before storing / querying.
 */
const hashToken = (rawToken) =>
  crypto.createHash("sha256").update(rawToken).digest("hex");

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

// BB-144: both emails use the shared design (src/emails/templates). The reset
// link lifetime is the real one (RESET_TOKEN_MINUTES), shown in the email.
const RESET_TOKEN_MINUTES = 5;
const NO_REPLY_FROM = `"BizBuddy Support" <no-reply@mybizbuddy.co>`;

/**
 * Send password reset instructions email.
 * @param {object} [extra] { firstName, device, timeZone } (BB-144)
 */
const sendResetPasswordEmail = async (email, rawToken, userName, companyName, extra = {}) => {
  try {
    const baseUrl = (process.env.FRONTEND_URL || "https://mybizbuddy.co").replace(/\/$/, "");
    const resetUrl = `${baseUrl}/reset-password/confirm?token=${rawToken}`;

    const { subject, html, text } = renderEmail("password-reset", {
      company_name: companyName,
      first_name: extra.firstName || userName,
      email,
      reset_url: resetUrl,
      requested_at: fmtDateTime(new Date(), extra.timeZone),
      device: extra.device || null,
      expires_in: fmtDuration(RESET_TOKEN_MINUTES),
    });

    await sendMail({ from: NO_REPLY_FROM, to: email, subject, html, text, log: { type: "PASSWORD_RESET", redact: [rawToken, resetUrl] } }); // BB-140: link hidden in the stored copy
    console.log(`Reset password email sent to: ${email}`);
    return true;
  } catch (error) {
    console.error("Error sending reset password email:", error);
    throw error;
  }
};

/**
 * Send a security alert after a successful password reset.
 * @param {object} [extra] { firstName, device, timeZone } (BB-144)
 */
const sendPasswordChangedEmail = async (email, userName, companyName, extra = {}) => {
  try {
    const { subject, html, text } = renderEmail("password-changed", {
      company_name: companyName,
      first_name: extra.firstName || userName,
      email,
      changed_at: fmtDateTime(new Date(), extra.timeZone),
      device: extra.device || null,
      // No "sign out everywhere" endpoint exists: the button opens Forgot password.
      secure_url: links.forgotPassword(),
    });

    await sendMail({ from: NO_REPLY_FROM, to: email, subject, html, text, log: { type: "PASSWORD_CHANGED" } }); // BB-140
    console.log(`Password changed alert email sent to: ${email}`);
    return true;
  } catch (error) {
    console.error("Error sending password changed email:", error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

const requestPasswordReset = async (req, res) => {
  try {
    const { email, userId } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ message: "Email and account selection are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find the specific user by id AND verify the email matches — prevents
    // an attacker from passing an arbitrary userId with someone else's email.
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        email: normalizedEmail,
        // BB-110: B. Buddy credentials are rotated centrally, never via reset link
        ...HUMAN_ONLY,
        // BB-107: inactive accounts get no reset email (same safe response)
        status: "active",
      },
      include: {
        profile: true,
        company: true,
      },
    });

    // Always return the same response to prevent user enumeration
    const safeResponse = {
      message: "If an account exists with this email, a password reset link has been sent.",
      success: true,
    };

    if (!user) {
      console.log(`Password reset attempted for unknown account: ${normalizedEmail} / ${userId}`);
      return res.status(200).json(safeResponse);
    }

    // Rate limit: 1 request per minute per specific user account
    const recentRequest = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 60 * 1000) },
      },
    });

    if (recentRequest) {
      console.log(`Rate-limited password reset for: ${normalizedEmail} (${user.id})`);
      return res.status(200).json(safeResponse);
    }

    // Generate raw token — only the hash goes into the DB
    const rawToken = generateResetToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000); // 5 minutes

    // Invalidate any existing unused tokens for this specific user account
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { expiresAt: new Date() },
    });

    // Store the HASH, send the RAW token to the user
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token: tokenHash,
        expiresAt,
      },
    });

    const userName =
      `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
      user.email;
    const companyName = user.company?.name;

    try {
      await sendResetPasswordEmail(normalizedEmail, rawToken, userName, companyName, {
        firstName: user.profile?.firstName?.trim() || null,
        device: describeDevice(req),
        timeZone: user.company?.timeZone,
      });
    } catch (emailError) {
      console.error("Reset email send failed:", emailError);
    }

    return res.status(200).json(safeResponse);
  } catch (error) {
    console.error("Error in requestPasswordReset:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------

const verifyResetToken = async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ message: "Reset token is required." });
    }

    const tokenHash = hashToken(token);

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token: tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: {
            profile: true,
            company: true,
          },
        },
      },
    });

    if (!resetToken) {
      return res.status(400).json({
        message: "Invalid or expired reset token.",
        expired: true,
      });
    }

    return res.status(200).json({
      message: "Reset token is valid.",
      success: true,
      data: {
        user: {
          email: resetToken.user.email,
          firstName: resetToken.user.profile?.firstName || "",
          lastName: resetToken.user.profile?.lastName || "",
          companyName: resetToken.user.company?.name || "",
        },
      },
    });
  } catch (error) {
    console.error("Error verifying reset token:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------

const resetPassword = async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required." });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters long." });
    }

    const tokenHash = hashToken(token);

    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token: tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: {
            profile: true,
            company: true,
          },
        },
      },
    });

    if (!resetToken) {
      return res.status(400).json({
        message: "Invalid or expired reset token.",
        expired: true,
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Atomic: update password + mark token used + invalidate remaining tokens + in-app notification
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword },
      });

      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true, usedAt: new Date() },
      });

      await tx.passwordResetToken.updateMany({
        where: {
          userId: resetToken.userId,
          used: false,
          id: { not: resetToken.id },
        },
        data: { expiresAt: new Date() },
      });

      // Only create notification if user belongs to a company
      if (resetToken.user.companyId) {
        await tx.notificationLog.create({
          data: {
            userId: resetToken.userId,
            companyId: resetToken.user.companyId,
            notificationCode: "PASSWORD_RESET_SUCCESS",
            title: "Password Changed",
            message:
              "Your account password was successfully reset. If you did not perform this action, please contact support immediately.",
            payload: {
              changedAt: new Date().toISOString(),
            },
          },
        });
      }
    });

    // Send security alert email (outside transaction — non-critical)
    const userName =
      `${resetToken.user.profile?.firstName || ""} ${resetToken.user.profile?.lastName || ""}`.trim() ||
      resetToken.user.email;
    const companyName = resetToken.user.company?.name;

    try {
      await sendPasswordChangedEmail(resetToken.user.email, userName, companyName, {
        firstName: resetToken.user.profile?.firstName?.trim() || null,
        device: describeDevice(req),
        timeZone: resetToken.user.company?.timeZone,
      });
    } catch (emailError) {
      console.error("Password changed alert email failed:", emailError);
    }

    console.log(`Password successfully reset for user: ${resetToken.user.email} (${resetToken.userId})`);

    return res.status(200).json({
      message: "Password has been reset successfully.",
      success: true,
    });
  } catch (error) {
    console.error("Error resetting password:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------

module.exports = {
  requestPasswordReset,
  verifyResetToken,
  resetPassword,
  // BB-140: System Admin test sends (services/Analytics/emailTemplateCatalog.js)
  sendResetPasswordEmail,
  sendPasswordChangedEmail,
};