// src/controllers/Analytics/onboardingWorkbookController.js
//
// BB-139: GET /api/system-admin/onboarding-workbook
// Streams the blank "New Business Requirement Details" workbook (.xlsx) that a
// system admin sends to a new business before provisioning it. No DB access.

const moment = require("moment-timezone");
const { generateNewBusinessWorkbook } = require("@utils/generateNewBusinessWorkbook");

const getOnboardingWorkbook = async (req, res) => {
  try {
    const buffer = await generateNewBusinessWorkbook();
    const filename = `BizBuddy_New_Business_Requirements_${moment().format("YYYY-MM-DD")}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("getOnboardingWorkbook error:", err);
    return res.status(500).json({ message: "Failed to build the onboarding workbook." });
  }
};

module.exports = { getOnboardingWorkbook };
