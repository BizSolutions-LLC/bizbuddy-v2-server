// src/controllers/Company/setupGuideController.js
//
// BB-115: the "Set up your business" checklist for the admin panel. Always
// scoped to the caller's own company. See setupGuideService.

const { getChecklist, updateGuide, SetupGuideError } = require("@services/Company/setupGuideService");

const handle = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    return res.status(200).json({ data });
  } catch (err) {
    if (err instanceof SetupGuideError) return res.status(err.status).json({ message: err.message });
    console.error("setupGuide error:", err);
    return res.status(500).json({ message: "Failed to load the setup guide." });
  }
};

// BB-120: B. Buddy's checklist leaves out the payroll step.
const viewer = (req) => ({ isSystemAgent: Boolean(req.user.isSystemAgent) });

/** GET /api/company-setup/checklist */
const getSetupChecklist = handle((req) => getChecklist(req.user.companyId, viewer(req)));

/** POST|DELETE /api/company-setup/checklist/steps/:key/skip */
const skipStep   = handle((req) => updateGuide(req.user.companyId, "skip", req.params.key, viewer(req)));
const unskipStep = handle((req) => updateGuide(req.user.companyId, "unskip", req.params.key, viewer(req)));

/** POST|DELETE /api/company-setup/checklist/steps/:key/review */
const reviewStep   = handle((req) => updateGuide(req.user.companyId, "review", req.params.key, viewer(req)));
const unreviewStep = handle((req) => updateGuide(req.user.companyId, "unreview", req.params.key, viewer(req)));

/** POST /api/company-setup/checklist/dismiss | /reopen */
const dismissGuide = handle((req) => updateGuide(req.user.companyId, "dismiss", undefined, viewer(req)));
const reopenGuide  = handle((req) => updateGuide(req.user.companyId, "reopen", undefined, viewer(req)));

module.exports = {
  getSetupChecklist,
  skipStep,
  unskipStep,
  reviewStep,
  unreviewStep,
  dismissGuide,
  reopenGuide,
};
