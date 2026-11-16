// src/controllers/Features/dailyTaskReportController.js
//
// BB-129: clock-out documentation (Daily Task Report), trial mode.
// Errors are JSON { message, code? }. Business rules live in
// services/Features/dailyTaskReportService.js.

const svc = require("@services/Features/dailyTaskReportService");
const { generateDailyTaskReportPDF } = require("@utils/generateDailyTaskReportPDF");

const handle = (name, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err instanceof svc.TaskReportError)
      return res.status(err.status).json({ message: err.message, ...(err.code && { code: err.code }) });
    console.error(`[BB-129] ${name} error:`, err);
    return res.status(500).json({ message: "Something went wrong with the task report." });
  }
};

const sendPdf = async (res, view) => {
  const buffer = await generateDailyTaskReportPDF(view);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${svc.pdfFileName(view)}"`);
  res.setHeader("Content-Length", buffer.length);
  return res.status(200).send(buffer);
};

// ── Employee: own reports ──
const listMine = handle("listMine", async (req, res) => res.json({ data: await svc.listMine(req.user, req.query) }));
const getMine = handle("getMine", async (req, res) => res.json({ data: await svc.getMine(req.user, req.params.date) }));
const saveMine = handle("saveMine", async (req, res) =>
  res.json({ message: req.body?.submit ? "Report submitted." : "Report saved.", data: await svc.saveMine(req.user, req.params.date, req.body) })
);
const getMinePdf = handle("getMinePdf", async (req, res) => sendPdf(res, await svc.loadForPdf(req.user, { ownDate: req.params.date })));

// ── Supervisor / admin: view only ──
const listTeam = handle("listTeam", async (req, res) => res.json({ data: await svc.listTeam(req.user, req.query) }));
const getOne = handle("getOne", async (req, res) => {
  const view = await svc.loadForView(req.user, { id: req.params.id });
  return res.json({ data: { ...view.report, employee: view.employee, attendance: view.attendance, timeZone: view.company.timeZone } });
});
const getOnePdf = handle("getOnePdf", async (req, res) => sendPdf(res, await svc.loadForPdf(req.user, { id: req.params.id })));

module.exports = { listMine, getMine, saveMine, getMinePdf, listTeam, getOne, getOnePdf };
