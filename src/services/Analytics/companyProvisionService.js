// src/services/Analytics/companyProvisionService.js
//
// BB-107: "Add company" in the system-admin dashboard. Creates the shell only —
// the company and its owner (admin), optionally its B. Buddy and a support staff
// member. Everything inside the company (departments, shifts, policies,
// employees) is then set up through B. Buddy in the Company panel, so it's
// audited with the staff member behind it.

const bcrypt = require("bcryptjs");
const { prisma } = require("@config/connection");
const { sendMail } = require("@utils/mailer");
const { renderWelcome } = require("@emails/renderTemplate");
const { BBUDDY_EMAIL, BBUDDY_PASSWORD_HASH } = require("@config/env");
const { createSystemAgentForCompany } = require("@services/systemAgentService");

const WELCOME_SUBJECT = "Welcome to BizBuddy — your account is ready";
const OPTIONAL_FIELDS = ["dba", "phoneNumber", "addressLine1", "addressLine2", "city", "state", "postalCode", "country", "currency"];

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

// Same convention as employeeController: first initial + last name (ccorcuera),
// with a number appended when taken. Usernames are unique across all companies.
async function generateUsername(firstName, lastName) {
  const base = (firstName.charAt(0) + lastName).toLowerCase().replace(/[^a-z0-9]/g, "") || "owner";
  let username = base;
  let counter = 1;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${base}${counter}`;
    counter++;
  }
  return username;
}

const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const cleanEmail = (v) => (clean(v) ? v.trim().toLowerCase() : null);

/**
 * Checks what would clash before anything is created. Used live by the form and
 * again on create. Returns { ok, errors: { field: message }, ownerOtherCompanies }.
 * An owner email already used in other companies is allowed (one person can own
 * or work in several companies); those companies are returned for an info note.
 */
async function checkProvision(body = {}) {
  const errors = {};
  const companyName = clean(body.companyName);
  const businessEmail = cleanEmail(body.businessEmail);
  const ein = clean(body.ein);
  const ownerEmail = cleanEmail(body.ownerEmail);

  if (companyName) {
    const same = await prisma.company.findFirst({
      where: { name: { equals: companyName, mode: "insensitive" } },
      select: { name: true },
    });
    if (same) errors.companyName = `A company named "${same.name}" already exists.`;
  }
  if (businessEmail) {
    const same = await prisma.company.findFirst({ where: { businessEmail }, select: { name: true } });
    if (same) errors.businessEmail = `This business email is already used by ${same.name}.`;
  }
  if (ein) {
    const same = await prisma.company.findFirst({ where: { ein }, select: { name: true } });
    if (same) errors.ein = `This EIN is already used by ${same.name}.`;
  }

  let ownerOtherCompanies = [];
  if (ownerEmail) {
    const accounts = await prisma.user.findMany({
      where: { email: ownerEmail, isSystemAgent: false },
      select: { status: true, role: true, company: { select: { id: true, name: true } } },
    });
    ownerOtherCompanies = accounts
      .filter((a) => a.company)
      .map((a) => ({ companyId: a.company.id, companyName: a.company.name, role: a.role, status: a.status }));
  }

  return { ok: Object.keys(errors).length === 0, errors, ownerOtherCompanies };
}

/** Subscription plans for the form's dropdown. */
async function listPlans() {
  return prisma.subscriptionPlan.findMany({
    orderBy: { price: "asc" },
    select: { id: true, name: true, rangeOfUsers: true, price: true, description: true },
  });
}

/**
 * Body: companyName*, timeZone, ein, businessEmail, + OPTIONAL_FIELDS,
 *       ownerFirstName*, ownerLastName*, ownerEmail*, ownerPassword* (≥ 8), ownerPhone,
 *       subscriptionPlanId, setupBBuddy (default true), supportAgentId (needs setupBBuddy),
 *       sendWelcomeEmail (default true)
 */
async function provisionCompany(body = {}) {
  const companyName = clean(body.companyName);
  const ownerEmail = cleanEmail(body.ownerEmail);
  const ownerFirstName = clean(body.ownerFirstName);
  const ownerLastName = clean(body.ownerLastName);
  const ownerPassword = typeof body.ownerPassword === "string" ? body.ownerPassword : "";
  const setupBBuddy = body.setupBBuddy !== false && body.setupBBuddy !== "false";
  const sendWelcomeEmail = body.sendWelcomeEmail !== false && body.sendWelcomeEmail !== "false";

  if (!companyName || !ownerEmail || !ownerFirstName || !ownerLastName || !ownerPassword) {
    throw httpError(400, "Company name, owner first name, last name, email and password are required.");
  }
  if (ownerPassword.length < 8) throw httpError(400, "The owner's password must be at least 8 characters.");

  const check = await checkProvision(body);
  if (!check.ok) throw httpError(409, Object.values(check.errors)[0], { errors: check.errors });

  if (body.subscriptionPlanId) {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: body.subscriptionPlanId }, select: { id: true } });
    if (!plan) throw httpError(400, "That subscription plan doesn't exist.");
  }

  if (setupBBuddy && (!BBUDDY_EMAIL || !BBUDDY_PASSWORD_HASH)) {
    throw httpError(400, "B. Buddy isn't configured on this server (BBUDDY_EMAIL / BBUDDY_PASSWORD_HASH). Untick B. Buddy or set them first.");
  }
  if (setupBBuddy && cleanEmail(BBUDDY_EMAIL) === ownerEmail) {
    throw httpError(400, "The owner can't use the B. Buddy email.");
  }

  let agent = null;
  if (body.supportAgentId) {
    if (!setupBBuddy) throw httpError(400, "A support staff member can only be assigned when B. Buddy is set up.");
    agent = await prisma.supportAgent.findUnique({
      where: { id: body.supportAgentId },
      select: { id: true, code: true, name: true, archivedAt: true, company: { select: { id: true, name: true } } },
    });
    if (!agent || agent.archivedAt) throw httpError(400, "That support staff member doesn't exist or was removed.");
  }

  const passwordHash = bcrypt.hashSync(ownerPassword, 10);
  const username = await generateUsername(ownerFirstName, ownerLastName);

  const result = await prisma.$transaction(async (tx) => {
    const details = Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, clean(body[f])]));
    const company = await tx.company.create({
      data: {
        name: companyName,
        timeZone: clean(body.timeZone) || "America/Los_Angeles",
        businessEmail: cleanEmail(body.businessEmail),
        ein: clean(body.ein),
        ...details,
      },
      select: { id: true, name: true },
    });

    const owner = await tx.user.create({
      data: {
        email: ownerEmail,
        username,
        password: passwordHash,
        role: "admin",
        status: "active",
        company: { connect: { id: company.id } },
        profile: {
          create: {
            firstName: ownerFirstName,
            lastName: ownerLastName,
            phoneNumber: clean(body.ownerPhone),
            username,
            email: ownerEmail,
          },
        },
      },
      select: { id: true, email: true, username: true, role: true, status: true },
    });

    // Same as self-signup: the company records its owner.
    await tx.company.update({ where: { id: company.id }, data: { userId: owner.id } });

    const subscription = body.subscriptionPlanId
      ? await tx.subscription.create({
          data: { userId: owner.id, companyId: company.id, planId: body.subscriptionPlanId, active: true, startDate: new Date() },
          select: { id: true, planId: true, active: true },
        })
      : null;

    const bbuddy = setupBBuddy
      ? await createSystemAgentForCompany(tx, company.id, { email: BBUDDY_EMAIL, passwordHash: BBUDDY_PASSWORD_HASH })
      : null;

    if (agent) await tx.supportAgent.update({ where: { id: agent.id }, data: { companyId: company.id } });

    return { company, owner, subscription, bbuddy };
  });

  const welcomeEmail = sendWelcomeEmail
    ? await sendWelcome({ ownerFirstName, companyName, ownerEmail, ownerPassword, ownerId: result.owner.id, companyId: result.company.id })
    : "skipped";

  return {
    company: result.company,
    owner: result.owner,
    subscription: result.subscription,
    bbuddy: { created: Boolean(result.bbuddy), userId: result.bbuddy?.id || null },
    supportAgent: agent
      ? { id: agent.id, code: agent.code, name: agent.name, movedFrom: agent.company || null }
      : null,
    ownerOtherCompanies: check.ownerOtherCompanies,
    welcomeEmail,
  };
}

// Never fails the request — the company already exists by now.
async function sendWelcome({ ownerFirstName, companyName, ownerEmail, ownerPassword, ownerId, companyId }) {
  const log = (status, errorMessage = null) =>
    prisma.emailNotificationLog
      .create({
        data: {
          notificationType: "WELCOME_EMAIL",
          recipientEmail: ownerEmail,
          recipientUserId: ownerId,
          companyId,
          subject: WELCOME_SUBJECT,
          body: JSON.stringify({ firstName: ownerFirstName, companyName }),
          status,
          errorMessage,
        },
      })
      .catch(() => {});

  try {
    await sendMail({
      to: ownerEmail,
      subject: WELCOME_SUBJECT,
      html: renderWelcome({ firstName: ownerFirstName, companyName, email: ownerEmail, password: ownerPassword }),
      text: `Hi ${ownerFirstName}, your BizBuddy admin account for ${companyName} has been created.\nEmail: ${ownerEmail}\nPassword: ${ownerPassword}`,
    });
    await log("sent");
    return "sent";
  } catch (error) {
    console.error("[provisionCompany] Failed to send welcome email:", error.message);
    await log("failed", error.message);
    return "failed";
  }
}

module.exports = { checkProvision, listPlans, provisionCompany };
