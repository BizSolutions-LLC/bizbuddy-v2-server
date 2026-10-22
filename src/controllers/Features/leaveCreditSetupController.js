// src/controllers/Features/leaveCreditSetupController.js
//
// BB-098 — Turning on leave grants / expiration. The client sends the
// settings form to /preview first (read-only), shows the admin the per-
// employee fiscal-year breakdown and anything that would expire immediately,
// then sends the same body to /apply once confirmed.
//
// Body (all optional, merged over the company's saved settings):
//   leaveGrantEnabled, leaveExpirationEnabled,
//   leaveGrantMode, leaveGrantHours, leaveYearStartMonth, leaveYearStartDay,
//   leaveCreditLifetimeYears, leaveExpiryReminderDays,
//   leaveRegularizationMonths, leaveRegularizationGrant

const { prisma } = require("@config/connection");
const {
  loadCreditCompany,
  normalizeCreditSettings,
  isTracked,
  buildSetupPreview,
  initializeCredits,
  expireDueCredits,
} = require("@services/Leave/leaveCreditService");

function _toggles(body, company) {
  return {
    leaveGrantEnabled: body.leaveGrantEnabled !== undefined
      ? Boolean(body.leaveGrantEnabled) : company.leaveGrantEnabled,
    leaveExpirationEnabled: body.leaveExpirationEnabled !== undefined
      ? Boolean(body.leaveExpirationEnabled) : company.leaveExpirationEnabled,
  };
}

async function _load(req, res) {
  const company = await loadCreditCompany(prisma, req.user.companyId);
  if (!company) {
    res.status(404).json({ message: "Company not found" });
    return null;
  }
  const { settings, errors } = normalizeCreditSettings(req.body || {}, company);
  if (errors.length) {
    res.status(400).json({ message: errors.join("; "), errors });
    return null;
  }
  return { company, settings, toggles: _toggles(req.body || {}, company) };
}

const previewSetup = async (req, res) => {
  try {
    const loaded = await _load(req, res);
    if (!loaded) return;
    const { company, settings, toggles } = loaded;
    const preview = await buildSetupPreview(company, settings, {
      expirationEnabled: toggles.leaveExpirationEnabled,
    });
    res.json({ data: { settings: { ...settings, ...toggles }, ...preview } });
  } catch (error) {
    console.error("leave credit previewSetup error:", error);
    res.status(500).json({ message: error.message || "Failed to build leave credit preview" });
  }
};

const applySetup = async (req, res) => {
  try {
    const loaded = await _load(req, res);
    if (!loaded) return;
    const { company, settings, toggles } = loaded;

    let applied;
    if (!isTracked(company)) {
      applied = await initializeCredits(company, settings, toggles);
    } else {
      await prisma.company.update({
        where: { id: company.id },
        data:  { ...settings, ...toggles },
      });
      // Same result the preview showed: lots already past their last usable
      // day go now rather than on the next scheduled run.
      applied = toggles.leaveExpirationEnabled
        ? { expired: await expireDueCredits({ ...company, ...settings, ...toggles }) }
        : {};
    }

    const fresh = await loadCreditCompany(prisma, company.id);
    res.json({ data: { applied, settings: fresh } });
  } catch (error) {
    console.error("leave credit applySetup error:", error);
    res.status(error.status || 500).json({ message: error.message || "Failed to apply leave credit setup" });
  }
};

module.exports = { previewSetup, applySetup };
