const { saveBreadcrumbs } = require("@services/Locations/locationBreadcrumbService");

const postLocationBreadcrumbs = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const outcome = await saveBreadcrumbs(req.user, req.body);
    if (outcome.error) {
      return res.status(outcome.error.status).json({
        message: outcome.error.message,
        code: outcome.error.code,
      });
    }
    return res.status(200).json({ data: { results: outcome.results } });
  } catch (err) {
    console.error("postLocationBreadcrumbs error:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = { postLocationBreadcrumbs };
