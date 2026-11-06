// src/services/systemAgentService.js
//
// BB-110: creates the per-company B. Buddy account. Kept free of module
// aliases so scripts/bb110-create-bbuddy-accounts.js can require it directly.
//
// One User row per company, all sharing one email + password hash. username
// is globally unique on both User and UserProfile, so it's derived from the
// company id.

const BBUDDY_FIRST_NAME = "B.";
const BBUDDY_LAST_NAME = "Buddy";

function bbuddyUsername(companyId) {
  return `bbuddy-${companyId}`;
}

function buildSystemAgentData(companyId, { email, passwordHash }) {
  const normalizedEmail = email.trim().toLowerCase();
  const username = bbuddyUsername(companyId);
  return {
    username,
    email: normalizedEmail,
    password: passwordHash,
    role: "admin",
    status: "active",
    isSystemAgent: true,
    company: { connect: { id: companyId } },
    profile: {
      create: {
        username,
        email: normalizedEmail,
        firstName: BBUDDY_FIRST_NAME,
        lastName: BBUDDY_LAST_NAME,
      },
    },
  };
}

// Creates B. Buddy for a new company inside the caller's transaction. Skips
// (with a warning) when BBUDDY_EMAIL / BBUDDY_PASSWORD_HASH aren't configured,
// so signup and provisioning never fail on it — the create script can add it later.
async function createSystemAgentForCompany(tx, companyId, { email, passwordHash } = {}) {
  if (!email || !passwordHash) {
    console.warn(`[BB-110] B. Buddy not created for company ${companyId}: BBUDDY_EMAIL / BBUDDY_PASSWORD_HASH not set.`);
    return null;
  }
  return tx.user.create({
    data: buildSystemAgentData(companyId, { email, passwordHash }),
    select: { id: true },
  });
}

module.exports = {
  BBUDDY_FIRST_NAME,
  BBUDDY_LAST_NAME,
  bbuddyUsername,
  buildSystemAgentData,
  createSystemAgentForCompany,
};
