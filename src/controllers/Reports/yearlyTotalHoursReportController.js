// src/controllers/Reports/yearlyTotalHoursReportController.js
//
// BB-087: generates and streams back the yearly total-hours Summary workbook
// (docs/Sample_Yearly_Total_Hours_Report.xlsx's Summary tab, automated).
// Admin/supervisor/superadmin only, companyId-scoped the same way as
// getPayrollExportBatchesByCompany in payrollExportController.js.

const { prisma } = require("@config/connection");
const { getYearlyTotalHoursSummary } = require("@services/Reports/yearlyTotalHoursReportService");
const { generateYearlyTotalHoursReportXlsx } = require("@utils/generateYearlyTotalHoursReportXlsx");

/**
 * GET /api/reports/yearly-total-hours/:companyId?year=YYYY
 */
const getYearlyTotalHoursReport = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { companyId: callerCompanyId, role } = req.user;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    if (!companyId) {
      return res.status(400).json({ message: "companyId is required." });
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

    const summary = await getYearlyTotalHoursSummary(companyId, year);
    const buffer = await generateYearlyTotalHoursReportXlsx(summary, company);

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
