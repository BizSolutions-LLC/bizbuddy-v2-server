// src/controllers/Features/requestAccountDeletion.js

const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { createNotification } = require("@services/notificationService");
const { HUMAN_ONLY } = require("@utils/systemAgent");
const { sendMail } = require("@utils/mailer"); // BB-140
const { renderEmail } = require("@emails/renderEmail"); // BB-144
const { fmtDuration } = require("@emails/emailFormat");

// BB-140: emails go through utils/mailer.sendMail (same SMTP account), so they are logged.


const generateVerificationCode = () => {
  return crypto.randomInt(100000, 999999).toString();
};

// BB-144: shared design (src/emails/templates/account-deletion-code.html); the
// code lifetime shown is the real one.
const DELETION_CODE_MINUTES = 10;

/**
 * @param {object} [extra] { firstName, companyName } (BB-144)
 */
const sendVerificationEmail = async (email, code, userName, extra = {}) => {
  try {
    const { subject, html, text } = renderEmail("account-deletion-code", {
      company_name: extra.companyName || null,
      first_name: extra.firstName || userName,
      email,
      code,
      expires_in: fmtDuration(DELETION_CODE_MINUTES),
    });

    await sendMail({ from: process.env.MAIL_FROM, to: email, subject, html, text, log: { type: "ACCOUNT_DELETION_CODE", redact: [code] } }); // BB-140: code hidden in the stored copy
    console.log(`✅ Verification email sent to: ${email}`);
    return true;
  } catch (error) {
    console.error("❌ Error sending email:", error);
    throw error;
  }
};

const checkEmailGenerateCode = async (req, res) => {
  try {
    const { email } = req.body;
    console.log(email);

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user first
    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail, ...HUMAN_ONLY },
      include: { profile: true, company: { select: { name: true } } },
    });

    // ✅ If user doesn't exist, skip all database OTP checks
    if (!user) {
      console.log(`⚠️ Account deletion attempt for non-existent email: ${normalizedEmail}`);
      return res.status(200).json({
        message: "If an account exists with this email, a verification code has been sent.",
        success: true,
      });
    }

    // ✅ Only check for recent requests if the user actually exists
    const recentRequest = await prisma.otp.findFirst({
      where: {
        userId: user.id,
        type: "account_deletion",
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000),
        },
      },
    });

    if (recentRequest) {
      console.log(`⏳ Rate-limited OTP request for: ${normalizedEmail}`);
      return res.status(200).json({
        message: "If an account exists with this email, a verification code has been sent.",
        success: true,
      });
    }

    // Generate and store a new code
    const verificationCode = generateVerificationCode();
    const expiresAt = new Date(Date.now() + DELETION_CODE_MINUTES * 60 * 1000);

    await prisma.otp.updateMany({
      where: {
        userId: user.id,
        type: "account_deletion",
        verified: false,
      },
      data: { expiresAt: new Date() },
    });

    await prisma.otp.create({
      data: {
        userId: user.id,
        type: "account_deletion",
        code: verificationCode,
        expiresAt,
      },
    });

    // Send verification email
    const userName =
      `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
      user.email;

    try {
      await sendVerificationEmail(normalizedEmail, verificationCode, userName, {
        firstName: user.profile?.firstName?.trim() || null,
        companyName: user.company?.name || null,
      });
      console.log(`✅ OTP created and email sent for: ${normalizedEmail}`);
    } catch (emailError) {
      console.error("Email send failed:", emailError);
    }

    return res.status(200).json({
      message: "If an account exists with this email, a verification code has been sent.",
      success: true,
    });
  } catch (error) {
    console.error("Error in checkEmailGenerateCode:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const verifyCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ message: "Email and verification code are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user
    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail, ...HUMAN_ONLY },
      include: { profile: true },
    });

    if (!user) {
      // ✅ Generic error message - don't reveal user doesn't exist
      return res.status(400).json({ message: "Invalid verification code." });
    }

    // Find valid OTP
    const otp = await prisma.otp.findFirst({
      where: {
        userId: user.id,
        type: "account_deletion",
        code,
        verified: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otp) {
      // Increment attempts if OTP exists
      await prisma.otp.updateMany({
        where: {
          userId: user.id,
          type: "account_deletion",
          code,
        },
        data: {
          attempts: { increment: 1 },
        },
      });

      return res.status(400).json({ message: "Invalid or expired verification code." });
    }

    // Check max attempts
    if (otp.attempts >= 5) {
      return res.status(400).json({ 
        message: "Too many attempts. Please request a new verification code." 
      });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Update OTP record
    await prisma.otp.update({
      where: { id: otp.id },
      data: {
        verified: true,
        verifiedAt: new Date(),
        token: verificationToken,
        expiresAt: tokenExpiresAt,
      },
    });

    return res.status(200).json({
      message: "Code verified successfully.",
      success: true,
      data: {
        user: {
          firstName: user.profile?.firstName || "",
          lastName: user.profile?.lastName || "",
        },
        verificationToken,
      },
    });
  } catch (error) {
    console.error("Error verifying code:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const confirmDeleteAccountRequest = async (req, res) => {
  try {
    const { email, verificationToken, confirmationText } = req.body;

    if (!email || !verificationToken || !confirmationText) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user
    const user = await prisma.user.findFirst({
      where: { email: normalizedEmail, ...HUMAN_ONLY },
      include: { 
        profile: true,
        company: true,
        department: true,
      },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid verification token." });
    }

    // Find verified OTP with matching token
    const otp = await prisma.otp.findFirst({
      where: {
        userId: user.id,
        type: "account_deletion",
        token: verificationToken,
        verified: true,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otp) {
      return res.status(400).json({ 
        message: "Invalid or expired verification token. Please start over." 
      });
    }

    // Verify confirmation text
    const expectedText = `Yes, I confirm to delete ${user.profile?.firstName || ""} ${user.profile?.lastName || ""} account.`.trim();
    if (confirmationText.trim() !== expectedText) {
      return res.status(400).json({ message: "Confirmation text does not match." });
    }

    // Check if there's already a pending deletion request
    const existingRequest = await prisma.accountDeletionRequest.findFirst({
      where: {
        userId: user.id,
        status: "pending",
      },
    });

    if (existingRequest) {
      return res.status(400).json({ 
        message: "You already have a pending deletion request. Please wait for admin review." 
      });
    }

    // ✅ CREATE DELETION REQUEST
    const deletionRequest = await prisma.accountDeletionRequest.create({
      data: {
        userId: user.id,
        requestedByUserId: user.id,
        companyId: user.companyId,
        departmentId: user.departmentId,
        verificationToken,
        verificationUsed: true,
        requestReason: "User-initiated account deletion request",
      },
    });

    // Notify all admins in the company about the deletion request
    try {
      const employeeName = `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email;
      const adminUsers = await prisma.user.findMany({
        where: {
          companyId: user.companyId,
          role: { in: ['admin', 'superadmin'] },
          ...HUMAN_ONLY,
          status: 'active',
        },
        select: { id: true, departmentId: true },
      });
      await Promise.all(adminUsers.map(admin =>
        createNotification({
          userId: admin.id,
          companyId: user.companyId,
          departmentId: admin.departmentId,
          notificationCode: 'DELETION_REQUEST_SUBMITTED',
          title: 'Account Deletion Request',
          message: `${employeeName} has submitted an account deletion request.`,
          payload: { requestId: deletionRequest.id, requesterId: user.id },
        })
      ));
    } catch (notifError) {
      console.error('❌ Failed to send deletion request notification:', notifError);
    }

    // Mark OTP as used
    await prisma.otp.update({
      where: { id: otp.id },
      data: { expiresAt: new Date() },
    });

    console.log(`✅ Deletion request created for user: ${normalizedEmail} (Request ID: ${deletionRequest.id})`);

    return res.status(200).json({
      message: "Account deletion request submitted successfully. Your company administrator will review your request.",
      success: true,
      data: {
        requestId: deletionRequest.id,
        status: "pending",
      },
    });
  } catch (error) {
    console.error("Error creating deletion request:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getAuthenticatedRequest = async (req, res) => {
  try {
    const { id, role, companyId } = req.user;

    if (!role || !companyId) {
      return res.status(400).json({ message: "Invalid user context." });
    }

    let whereCondition = {};

    // Role-based access control
    if (role === "admin" || role === "superadmin") {
      // Admins see all requests in their company
      whereCondition = { companyId };
    } else if (role === "departmentHead") {
      // Department heads only see requests within their department
      const user = await prisma.user.findUnique({
        where: { id },
        select: { departmentId: true },
      });

      if (!user?.departmentId) {
        return res.status(403).json({ message: "No department assigned." });
      }

      whereCondition = {
        companyId,
        departmentId: user.departmentId,
      };
    } else {
      // Employees and other roles not allowed
      return res.status(403).json({ message: "Access denied." });
    }

    const requests = await prisma.accountDeletionRequest.findMany({
      where: whereCondition,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        },
        department: { select: { name: true } },
        company: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
    });
  } catch (error) {
    console.error("Error fetching deletion requests:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};


module.exports = {
  checkEmailGenerateCode,
  verifyCode,
  confirmDeleteAccountRequest,
  getAuthenticatedRequest,
  sendVerificationEmail, // BB-140: System Admin test sends
};