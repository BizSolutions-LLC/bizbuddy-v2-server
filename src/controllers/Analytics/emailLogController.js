// src/controllers/Analytics/emailLogController.js
//
// BB-140: System Admin view of every email the server sends (read-only), plus
// test sends of each template to any address.
//   GET  /api/system-admin/emails
//   GET  /api/system-admin/emails/templates
//   POST /api/system-admin/emails/test      { template, to }
//   GET  /api/system-admin/emails/:id

const { listEmails, getEmail, EmailLogError } = require("@services/Analytics/emailLogService");
const { listTemplates, findTemplate } = require("@services/Analytics/emailTemplateCatalog");
const { withEmailContext } = require("@utils/emailContext");

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/;
const TESTS_PER_HOUR = 30; // per system admin, in memory (resets on restart)
const recentTests = new Map(); // adminId → [timestamps]

const fail = (res, err, label) => {
  if (err instanceof EmailLogError) return res.status(err.status).json({ message: err.message });
  console.error(`[BB-140] ${label} error:`, err);
  return res.status(500).json({ message: "Failed to load emails." });
};

const getEmails = async (req, res) => {
  try {
    return res.json({ data: await listEmails(req.query) });
  } catch (err) {
    return fail(res, err, "getEmails");
  }
};

const getEmailDetail = async (req, res) => {
  try {
    return res.json({ data: await getEmail(req.params.id) });
  } catch (err) {
    return fail(res, err, "getEmailDetail");
  }
};

const getEmailTemplates = (req, res) => res.json({ data: { templates: listTemplates() } });

const sendTestEmail = async (req, res) => {
  const { template, to } = req.body || {};
  const tpl = findTemplate(String(template || ""));
  if (!tpl) return res.status(400).json({ message: "Pick a template from GET /api/system-admin/emails/templates." });
  const address = String(to || "").trim();
  if (!EMAIL_RE.test(address) || address.length > 254) return res.status(400).json({ message: "Enter one valid email address." });

  const adminId = req.systemAdmin?.id || "unknown";
  const now = Date.now();
  const recent = (recentTests.get(adminId) || []).filter((t) => now - t < 3600000);
  if (recent.length >= TESTS_PER_HOUR) {
    return res.status(429).json({ message: `At most ${TESTS_PER_HOUR} test emails per hour. Try again later.` });
  }
  recent.push(now);
  recentTests.set(adminId, recent);

  try {
    await withEmailContext({ isTest: true, triggeredBy: `system-admin:${adminId}` }, () => tpl.send(address));
    return res.json({
      message: `Test "${tpl.label}" sent to ${address}. It appears in the email list as a test.`,
      data: { template: tpl.key, to: address, status: "sent" },
    });
  } catch (err) {
    console.error("[BB-140] test email failed:", err.message);
    return res.status(502).json({
      message: `The test email couldn't be sent: ${err.message}`,
      data: { template: tpl.key, to: address, status: "failed" },
    });
  }
};

module.exports = { getEmails, getEmailDetail, getEmailTemplates, sendTestEmail };
