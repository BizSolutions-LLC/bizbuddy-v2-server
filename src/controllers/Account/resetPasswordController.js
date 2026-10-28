// src/controllers/Account/resetPasswordController.js

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { prisma } = require("@config/connection");
const { HUMAN_ONLY } = require("@utils/systemAgent");

// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  host: "smtp.dreamhost.com",
  port: "587",
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

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

/**
 * Send password reset instructions email.
 * Uses table-based layout for maximum email client compatibility.
 */
const sendResetPasswordEmail = async (email, rawToken, userName, companyName) => {
  try {
    const baseUrl = (process.env.FRONTEND_URL || "https://mybizbuddy.co").replace(/\/$/, "");
    const resetUrl = `${baseUrl}/reset-password/confirm?token=${rawToken}`;

    const mailOptions = {
      from: `"BizBuddy Support" <no-reply@mybizbuddy.co>`,
      to: email,
      subject: "Your BizBuddy Account - Password Reset Instructions",
      html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td align="center" style="background-color:#ea580c;padding:30px;border-radius:10px 10px 0 0;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-family:Arial,sans-serif;">
                Password Reset Request
              </h1>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="background-color:#f9fafb;padding:30px;border-radius:0 0 10px 10px;">

              <p style="margin:0 0 16px;">Hello <strong>${userName}</strong>,</p>
              <p style="margin:0 0 24px;">
                We received a request to reset the password for your BizBuddy account
                ${companyName ? `at <strong>${companyName}</strong>` : ""}.
              </p>

              <!-- TABLE-BASED BUTTON -->
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" bgcolor="#ea580c" style="border-radius:8px;">
                    <a href="${resetUrl}"
                       target="_blank"
                       style="display:inline-block;padding:14px 32px;color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;border-radius:8px;background-color:#ea580c;mso-padding-alt:14px 32px;">
                      Reset My Password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;">If the button above doesn't work, copy and paste this link into your browser:</p>

              <!-- LINK BOX -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
                <tr>
                  <td style="background-color:#ffffff;border:2px solid #f97316;border-radius:8px;padding:16px;word-break:break-all;text-align:center;">
                    <a href="${resetUrl}" style="color:#f97316;font-weight:bold;font-size:13px;text-decoration:none;">${resetUrl}</a>
                  </td>
                </tr>
              </table>

              <!-- WARNING BOX -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
                <tr>
                  <td style="background-color:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;padding:15px;color:#92400e;">
                    <strong>Important:</strong><br/>
                    This password reset link will expire in <strong>5 minutes</strong> for your security.
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px;">If you did not request a password reset, please ignore this email. Your account will remain secure.</p>
              <p style="margin:0;">Best regards,<br/><strong>BizBuddy Team</strong></p>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding:20px;color:#6b7280;font-size:12px;font-family:Arial,sans-serif;">
              <p style="margin:0;">This is an automated email. Please do not reply to this message.</p>
              <p style="margin:4px 0 0;">&copy; 2026 BizBuddy. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Reset password email sent to: ${email}`);
    return true;
  } catch (error) {
    console.error("Error sending reset password email:", error);
    throw error;
  }
};

/**
 * Send a security alert after a successful password reset.
 */
const sendPasswordChangedEmail = async (email, userName, companyName) => {
  try {
    const supportEmail = "support@mybizbuddy.co";
    const changedAt = new Date().toLocaleString("en-US", {
      dateStyle: "full",
      timeStyle: "short",
    });

    const mailOptions = {
      from: `"BizBuddy Support" <no-reply@mybizbuddy.co>`,
      to: email,
      subject: "Your BizBuddy Password Has Been Changed",
      html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,sans-serif;line-height:1.6;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td align="center" style="background-color:#ea580c;padding:30px;border-radius:10px 10px 0 0;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-family:Arial,sans-serif;">
                Password Successfully Changed
              </h1>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="background-color:#f9fafb;padding:30px;border-radius:0 0 10px 10px;">

              <p style="margin:0 0 16px;">Hello <strong>${userName}</strong>,</p>
              <p style="margin:0 0 16px;">
                Your password for your BizBuddy account
                ${companyName ? `at <strong>${companyName}</strong>` : ""}
                was successfully changed on <strong>${changedAt}</strong>.
              </p>

              <!-- ALERT BOX -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
                <tr>
                  <td style="background-color:#fee2e2;border-left:4px solid #ef4444;border-radius:4px;padding:15px;color:#7f1d1d;">
                    <strong>Wasn't you?</strong><br/>
                    If you did not make this change, your account may be compromised.
                    Please contact our support team immediately at
                    <a href="mailto:${supportEmail}" style="color:#ef4444;">${supportEmail}</a>.
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px;">If this was you, no further action is needed. You can now log in with your new password.</p>
              <p style="margin:0;">Best regards,<br/><strong>BizBuddy Team</strong></p>

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding:20px;color:#6b7280;font-size:12px;font-family:Arial,sans-serif;">
              <p style="margin:0;">This is an automated security alert. Please do not reply to this message.</p>
              <p style="margin:4px 0 0;">&copy; 2026 BizBuddy. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    };

    await transporter.sendMail(mailOptions);
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
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

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
      await sendResetPasswordEmail(normalizedEmail, rawToken, userName, companyName);
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
      await sendPasswordChangedEmail(resetToken.user.email, userName, companyName);
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
};