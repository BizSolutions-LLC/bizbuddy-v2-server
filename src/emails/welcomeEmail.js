// src/emails/welcomeEmail.js
//
// BB-144: the welcome email (new account + temporary password), shared by
// Add employee, bulk add, self sign-up and System Admin "Add company". Replaces
// emails/welcome_bizbuddy.html + renderTemplate.renderWelcome.
//
// The password does not expire and no change is forced at first sign-in, so the
// email only asks the person to change it (BB-144 decision). Callers keep
// passing the password in log.redact so the stored copy hides it (BB-140).

const { prisma } = require("@config/connection");
const { renderEmail, links } = require("@emails/renderEmail");
const { fullNameOf } = require("@emails/emailFormat");

const ROLE_LABELS = { employee: "Employee", supervisor: "Supervisor", admin: "Admin", superadmin: "Admin" };

/** Display name of the person who created the account (null when unknown). */
async function creatorName(userId) {
  if (!userId) return null;
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, isSystemAgent: true, profile: { select: { firstName: true, lastName: true } } },
    });
    if (!u) return null;
    if (u.isSystemAgent) return "BizBuddy Support"; // BB-110: B. Buddy is never named as a person
    return fullNameOf(u) || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string} o.firstName
 * @param {string} o.companyName
 * @param {string} o.email
 * @param {string} o.password       temporary password (shown once)
 * @param {string} [o.createdById]  user who created the account
 * @param {string} [o.department]
 * @param {string} [o.role]         User.role
 * @returns {Promise<{ subject, html, text }>}
 */
async function buildWelcomeEmail({ firstName, companyName, email, password, createdById = null, department = null, role = null }) {
  return renderEmail("welcome", {
    first_name: firstName,
    created_by: await creatorName(createdById),
    company_name: companyName,
    email,
    department,
    role: role ? ROLE_LABELS[role] || role : null,
    temp_password: password,
    login_url: links.signIn(),
  });
}

module.exports = { buildWelcomeEmail };
