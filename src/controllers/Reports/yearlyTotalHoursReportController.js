// src/controllers/Reports/yearlyTotalHoursReportController.js
//
// BB-087: generates and streams back the yearly total-hours Summary workbook
// (docs/Sample_Yearly_Total_Hours_Report.xlsx's Summary tab, automated).
// Admin/supervisor/superadmin only, companyId-scoped the same way as
// getPayrollExportBatchesByCompany in payrollExportController.js.

const { prisma } = require("@config/connection");
const {
  getYearlyTotalHoursSummary,
  GROUP_BY_KEYS,
  OPTIONAL_COLUMNS,
} = require("@services/Reports/yearlyTotalHoursReportService");
const { generateYearlyTotalHoursReportXlsx } = require("@utils/generateYearlyTotalHoursReportXlsx");

function parseList(value) {
  if (!value) return [];
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * GET /api/reports/yearly-total-hours/:companyId
 *   ?year=YYYY
 *   &groupBy=month|quarter|year     (default month)
 *   &periods=Jan,Feb,... | Q1,Q2,... (default all for groupBy; ignored for year)
 *   &columns=driver,regular,leave,ot,average (default none — Total only)
 */
const getYearlyTotalHoursReport = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { companyId: callerCompanyId, role } = req.user;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required." });
    }

    const groupBy = req.query.groupBy || "month";
    if (!GROUP_BY_KEYS[groupBy]) {
      return res.status(400).json({ message: "groupBy must be 'month', 'quarter' or 'year'." });
    }

    // Yearly is always the whole year — periods is ignored rather than rejected.
    const validPeriods = GROUP_BY_KEYS[groupBy];
    const periods = groupBy === "year" ? [] : parseList(req.query.periods);
    const invalidPeriods = periods.filter((p) => !validPeriods.includes(p));
    if (invalidPeriods.length) {
      return res.status(400).json({
        message: `Invalid periods for groupBy=${groupBy}: ${invalidPeriods.join(", ")}. Allowed: ${validPeriods.join(", ")}.`,
      });
    }

    const columns = parseList(req.query.columns);
    const invalidColumns = columns.filter((c) => !OPTIONAL_COLUMNS.includes(c));
    if (invalidColumns.length) {
      return res.status(400).json({
        message: `Invalid columns: ${invalidColumns.join(", ")}. Allowed: ${OPTIONAL_COLUMNS.join(", ")}.`,
      });
    }

    if (role !== "superadmin" && companyId !== callerCompanyId) {
      return res.status(403).json({ message: "Access denied: insufficient permissions." });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    if (!company) {
      return res.status(404).json({ message: "Company not found." });
    }

    const summary = await getYearlyTotalHoursSummary(companyId, year, { groupBy, periods });
    const buffer = await generateYearlyTotalHoursReportXlsx(summary, company, columns);

    const filename = `${company.name.replace(/[^a-z0-9]+/gi, "_")}_Yearly_Total_Hours_${year}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("❌ getYearlyTotalHoursReport:", error);
    return res.status(500).json({ message: "Internal server error.", error: error.message });
  }
};

module.exports = { getYearlyTotalHoursReport };
