// src/controllers/Analytics/subscriptionPlanOverviewController.js
//
// BB-132: read-only subscription plan showcase for the system-admin dashboard.

const plans = require("@services/Analytics/subscriptionPlanOverviewService");

/** GET /api/system-admin/subscription-plans/overview — every plan + company counts + totals */
async function getPlansOverview(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await plans.getOverview() });
  } catch (error) {
    next(error);
  }
}

/** GET /api/system-admin/subscription-plans/:id[?includeRetired=true] — one plan + its companies */
async function getPlanDetail(req, res, next) {
  try {
    const includeRetired = String(req.query.includeRetired || "").toLowerCase() === "true";
    const data = await plans.getPlanDetail(req.params.id, { includeRetired });
    if (!data) {
      return res.status(404).json({ success: false, message: "Subscription plan not found." });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { getPlansOverview, getPlanDetail };
