// src/controllers/Features/taskReportFormController.js
//
// BB-129: custom clock-out documentation forms.
//   phase 1 — admin form builder (taskReportFormService)
//   phase 2 — assignments (taskReportFormAssignmentService) and answering /
//             viewing (taskReportFormResponseService)
// Errors are JSON { message, code? }. Business rules live in the services.

const svc = require("@services/Features/taskReportFormService");
const assignmentSvc = require("@services/Features/taskReportFormAssignmentService");
const responseSvc = require("@services/Features/taskReportFormResponseService");
const { generateTaskReportFormPDF } = require("@utils/generateTaskReportFormPDF");

const KNOWN_ERRORS = [svc.TaskReportFormError, assignmentSvc.TaskReportFormAssignmentError, responseSvc.TaskReportFormResponseError];

const handle = (name, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (KNOWN_ERRORS.some((E) => err instanceof E))
      return res.status(err.status).json({ message: err.message, ...(err.code && { code: err.code }) });
    console.error(`[BB-129 forms] ${name} error:`, err);
    return res.status(500).json({ message: "Something went wrong with the form." });
  }
};

// ── Admin: form builder (phase 1) ──
const list = handle("list", async (req, res) =>
  res.json({ data: await svc.list(req.user, req.query), questionTypes: svc.QUESTION_TYPES })
);
const getOne = handle("getOne", async (req, res) => res.json({ data: await svc.getOne(req.user, req.params.id) }));
const create = handle("create", async (req, res) =>
  res.status(201).json({ message: "Form created.", data: await svc.create(req.user, req.body) })
);
const update = handle("update", async (req, res) =>
  res.json({ message: "Form saved.", data: await svc.update(req.user, req.params.id, req.body) })
);
const duplicate = handle("duplicate", async (req, res) =>
  res.status(201).json({ message: "Form duplicated.", data: await svc.duplicate(req.user, req.params.id, req.body) })
);
const archive = handle("archive", async (req, res) =>
  res.json({ message: "Form archived.", data: await svc.archive(req.user, req.params.id) })
);
const restore = handle("restore", async (req, res) =>
  res.json({ message: "Form restored.", data: await svc.restore(req.user, req.params.id) })
);
const remove = handle("remove", async (req, res) =>
  res.json({ message: "Form deleted.", data: await svc.remove(req.user, req.params.id) })
);

// ── Admin: assignments (phase 2) ──
const listAssignments = handle("listAssignments", async (req, res) =>
  res.json({ data: await assignmentSvc.list(req.user), scopes: assignmentSvc.SCOPES })
);
const setAssignment = handle("setAssignment", async (req, res) =>
  res.json({ message: "Form assigned.", data: await assignmentSvc.set(req.user, req.body) })
);
const removeAssignment = handle("removeAssignment", async (req, res) =>
  res.json({ message: "Assignment removed.", data: await assignmentSvc.remove(req.user, req.params.id) })
);

// ── Employee: answering (phase 2) ──
const myPending = handle("myPending", async (req, res) => res.json({ data: await responseSvc.pending(req.user) }));
const myOpen = handle("myOpen", async (req, res) =>
  res.json({ data: await responseSvc.openForPunch(req.user, req.params.timeLogId) })
);
const myOpenActive = handle("myOpenActive", async (req, res) =>
  res.json({ data: await responseSvc.openForActivePunch(req.user) })
);
const mySave = handle("mySave", async (req, res) =>
  res.json({
    message: req.body?.submit === true || req.body?.submit === "true" ? "Questionnaire submitted." : "Questionnaire saved.",
    data: await responseSvc.saveForPunch(req.user, req.params.timeLogId, req.body, req.file),
  })
);
const myResponses = handle("myResponses", async (req, res) =>
  res.json({ data: await responseSvc.listMine(req.user, req.query) })
);

// ── Owner / supervisor / admin: one answer set (phase 2) ──
const getResponse = handle("getResponse", async (req, res) =>
  res.json({ data: await responseSvc.getOne(req.user, req.params.id) })
);

// PDF of a submitted questionnaire. ?disposition=inline opens it in the browser
// ("View PDF"); default is a download.
const getResponsePdf = handle("getResponsePdf", async (req, res) => {
  const view = await responseSvc.loadForPdf(req.user, req.params.id);
  const buffer = await generateTaskReportFormPDF(view);
  const inline = req.query.disposition === "inline";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${responseSvc.pdfFileName(view)}"`);
  res.setHeader("Content-Length", buffer.length);
  return res.status(200).send(buffer);
});

module.exports = {
  list, getOne, create, update, duplicate, archive, restore, remove,
  listAssignments, setAssignment, removeAssignment,
  myPending, myOpen, myOpenActive, mySave, myResponses,
  getResponse, getResponsePdf,
};
