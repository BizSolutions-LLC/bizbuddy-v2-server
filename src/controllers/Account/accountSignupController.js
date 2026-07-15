// src/controllers/Account/accountSignupController.js

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("@config/connection");
const { JWT_SECRET } = require("@config/env");
const { sendMail } = require("@utils/mailer");
const { renderWelcome } = require("@emails/renderTemplate");
const { getDirectSupervisors } = require("@services/Approvers/approverResolutionService");

const getAllSubscriptionPlans = async (req, res) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: { name: "asc" },
    });
    return res.status(200).json({
      message: "Subscription plans retrieved successfully.",
      data: plans,
    });
  } catch (error) {
    console.error("Error in getAllSubscriptionPlans:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const checkCompanyName = async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ message: "Company name is required." });
    }
    const company = await prisma.company.findFirst({
      where: { name: { equals: name.trim(), mode: "insensitive" } },
    });
    return res.status(200).json({
      message: "Company name check complete.",
      data: { exists: !!company },
    });
  } catch (error) {
    console.error("Error in checkCompanyName:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const checkUsername = async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ message: "Username is required." });
    }
    const existingUser = await prisma.user.findUnique({
      where: { username: username.trim().toLowerCase() },
    });
    return res.status(200).json({
      message: "Username check complete.",
      data: { available: !existingUser },
    });
  } catch (error) {
    console.error("Error in checkUsername:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const signUp = async (req, res) => {
  try {
    const { firstName, lastName, email, password, companyName, country, currency, language, subscriptionPlanId, isPaid, username } = req.body;
    const plainPassword = password;

    if (!firstName || !lastName || !email || !password || !companyName || !subscriptionPlanId) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username: username.trim().toLowerCase() },
      });
      if (existingUsername) {
        return res.status(409).json({ message: "Username already exists." });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username ? username.trim().toLowerCase() : normalizedEmail;
    const result = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username: normalizedUsername,
          email: normalizedEmail,
          password: hashedPassword,
          role: "admin",
        },
      });

      await tx.userProfile.create({
        data: {
          userId: newUser.id,
          username: newUser.username,
          email: newUser.email,
          firstName,
          lastName,
        },
      });

      const newCompany = await tx.company.create({
        data: {
          name: companyName,
          userId: newUser.id,
          country: country || "",
          currency: currency || "",
          language: language || "",
        },
      });

      await tx.user.update({
        where: { id: newUser.id },
        data: { companyId: newCompany.id },
      });

      if (!JWT_SECRET) throw new Error("JWT secret is not configured.");
      const token = jwt.sign({ userId: newUser.id, role: newUser.role, companyId: newCompany.id }, JWT_SECRET, { expiresIn: "10y" });
      const subscriptionPlan = await tx.subscriptionPlan.findUnique({
        where: { id: subscriptionPlanId },
      });
      if (!subscriptionPlan) {
        throw new Error("Invalid subscription plan.");
      }
      const isSubscriptionActive = !!isPaid;
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
      const newSubscription = await tx.subscription.create({
        data: {
          userId: newUser.id,
          companyId: newCompany.id,
          planId: subscriptionPlan.id,
          active: isSubscriptionActive,
          startDate,
          endDate,
        },
      });

      return { token, newUser, newCompany, newSubscription };
    });

    try {
      const html = renderWelcome({
        firstName,
        companyName,
        email: result.newUser.email,
        password: plainPassword, // you decided no token TTL; you’re emailing it
      });
    
      await sendMail({
        to: result.newUser.email,
        subject: "Welcome to BizBuddy — your account is live",
        html,
        text: `Hi ${firstName}, your BizBuddy account for ${companyName} is ready.
    Email: ${result.newUser.email}
    Password: ${plainPassword}
    `,
      });
      // optional: log success
      console.log(`[signUp] Welcome email sent to ${result.newUser.email}`);
    } catch (err) {
      console.error("[signUp] Failed to send welcome email:", err);
      // do not throw; account is already created
    }

    return res.status(201).json({
      message: "Account, company, and subscription created successfully.",
      data: {
        token: result.token,
        user: {
          id: result.newUser.id,
          email: result.newUser.email,
          role: result.newUser.role,
          companyId: result.newCompany.id,
        },
        subscription: result.newSubscription,
      },
    });
  } catch (error) {
    console.error("Error in signUp:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const getApprover = async (req, res) => {
  try {
    const data = await getDirectSupervisors({ id: req.user.id, companyId: req.user.companyId });

    if (data === null) {
      return res.status(404).json({ error: "User not found or company mismatch" });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error fetching approvers:', error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message
    });
  }
};

module.exports = {
  getAllSubscriptionPlans,
  checkCompanyName,
  checkUsername,
  signUp,
  getApprover
};
