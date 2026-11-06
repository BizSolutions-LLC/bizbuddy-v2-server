// src/controllers/Superadmin/provisionController.js
//
// System-admin "Add company" (BB-107). Logic lives in companyProvisionService.

const provision = require("@services/Analytics/companyProvisionService");

function sendError(res, error) {
  if (error.status) {
    return res.status(error.status).json({ message: error.message, ...(error.details || {}) });
  }
  console.error("❌ Error in provisionCompany:", error);
  return res.status(500).json({ message: "Internal server error." });
}

/**
 * POST /api/system-admin/provision-company
 * Creates the company + owner, optionally its B. Buddy (setupBBuddy, default true)
 * and assigns a support staff member (supportAgentId). 409 { message, errors } on clashes.
 */
const provisionCompany = async (req, res) => {
  try {
    const data = await provision.provisionCompany(req.body);
    return res.status(201).json({ message: `${data.company.name} created.`, data });
  } catch (error) {
    return sendError(res, error);
  }
};

/**
 * POST /api/system-admin/provision-company/check
 * Body: { companyName?, businessEmail?, ein?, ownerEmail? } → { ok, errors, ownerOtherCompanies }
 */
const checkProvision = async (req, res) => {
  try {
    return res.status(200).json({ data: await provision.checkProvision(req.body) });
  } catch (error) {
    return sendError(res, error);
  }
};

/** GET /api/system-admin/subscription-plans */
const listPlans = async (req, res) => {
  try {
    return res.status(200).json({ data: await provision.listPlans() });
  } catch (error) {
    return sendError(res, error);
  }
};

module.exports = { provisionCompany, checkProvision, listPlans };
