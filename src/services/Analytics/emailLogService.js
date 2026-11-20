// src/services/Analytics/emailLogService.js
//
// BB-140: every outgoing email, viewable in System Admin.
//
//   - recordEmail(): called by utils/mailer.sendMail after every send (sent or
//     failed). Never throws: a logging problem must never block an email.
//       * One EmailNotificationLog row (summary, kept 1 year:
//         jobs/emailLogRetentionJob.js).
//       * A copy of the email (subject, html, text, from, to) in S3
//         (AWS_S3_EMAIL_BUCKET, key yyyy/mm/<id>.json), deleted by the bucket's
//         lifecycle rule after 90 days.
//       * Sensitive values are hidden BEFORE anything is stored
//         (utils/emailRedact): the sender's `redact` list + secret URL params.
//   - listEmails() / getEmail(): read-only System Admin views. getEmail() loads
//     the copy and checks every image in it (does the link load an image?).

const crypto = require("crypto");
const moment = require("moment-timezone");
const { Prisma } = require("@prisma/client");
const { prisma } = require("@config/connection");
const { redactEmail } = require("@utils/emailRedact");
const { emailContext } = require("@utils/emailContext");
const s3 = require("@utils/s3");

const COPY_DAYS = 90; // S3 lifecycle rule "expire-email-archive"
const SUMMARY_DAYS = 365; // emailLogRetentionJob
const MAX_RANGE_DAYS = 92;
const MAX_IMAGES = 15;

class EmailLogError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/** Who the email belongs to when the sender didn't say: one user with that email → their company. */
async function guessRecipient(email) {
  try {
    const users = await prisma.user.findMany({
      where: { email: { equals: String(email), mode: "insensitive" } },
      select: { id: true, companyId: true },
      take: 2,
    });
    return users.length === 1 ? { userId: users[0].id, companyId: users[0].companyId } : {};
  } catch {
    return {};
  }
}

/**
 * Record one outgoing email. Never throws.
 * @param {object} p
 * @param {string|string[]} p.to
 * @param {string} p.from
 * @param {string} p.subject  as sent (already "[TEST]"-prefixed for tests)
 * @param {string} [p.html]
 * @param {string} [p.text]
 * @param {"sent"|"failed"} p.status
 * @param {object} [p.info]   nodemailer result (messageId, accepted, rejected, response)
 * @param {Error}  [p.error]
 * @param {object} [p.log]    { type, notificationType, companyId, userId, triggeredBy, metadata, redact[] }
 */
async function recordEmail({ to, from, subject, html, text, status, info, error, log = {} }) {
  try {
    const ctx = emailContext();
    const recipients = list(to).map(String);
    const recipientEmail = recipients.join(", ").slice(0, 500);

    let { companyId = null, userId = null } = log;
    if (!companyId && !userId && recipients.length === 1) {
      ({ companyId = null, userId = null } = await guessRecipient(recipients[0]));
    }

    const red = redactEmail({ subject, html, text }, log.redact);
    const id = crypto.randomUUID();
    const sentAt = new Date();

    let archiveKey = null;
    if (s3.isConfigured("email")) {
      const key = `${moment.utc(sentAt).format("YYYY/MM")}/${id}.json`;
      const copy = JSON.stringify({ from, to: recipients, subject: red.subject, html: red.html || null, text: red.text || null, sentAt });
      try {
        await s3.putObject(key, copy, "application/json; charset=utf-8", "email");
        archiveKey = key;
      } catch (e) {
        console.error("[BB-140] email copy upload failed:", e.message);
      }
    }

    const notificationType = log.notificationType || null;
    await prisma.emailNotificationLog.create({
      data: {
        id,
        notificationType,
        emailType: String(log.type || notificationType || "OTHER").slice(0, 64),
        isTest: Boolean(ctx.isTest),
        recipientEmail,
        recipientUserId: userId,
        companyId,
        subject: (red.subject || "").slice(0, 500),
        body: null,
        sentAt,
        status,
        errorMessage: error ? String(error.message || error).slice(0, 1000) : null,
        metadata: log.metadata && typeof log.metadata === "object" ? log.metadata : undefined,
        fromAddress: from ? String(from).slice(0, 255) : null,
        messageId: info?.messageId || null,
        accepted: info?.accepted ? info.accepted.map(String) : undefined,
        rejected: info?.rejected ? info.rejected.map(String) : undefined,
        smtpResponse: info?.response ? String(info.response).slice(0, 500) : error?.response ? String(error.response).slice(0, 500) : null,
        triggeredBy: (log.triggeredBy || ctx.triggeredBy || null)?.toString().slice(0, 120) ?? null,
        sizeBytes: Buffer.byteLength(String(html || "") + String(text || ""), "utf8"),
        redactedCount: red.count,
        archiveKey,
      },
    });
  } catch (e) {
    console.error("[BB-140] recording an email failed:", e.message);
  }
}

// ── System Admin views ────────────────────────────────────────────────────────

const copyAvailable = (row) =>
  Boolean(row.archiveKey) && moment().diff(moment(row.sentAt), "days", true) < COPY_DAYS;

function shapeRow(r) {
  return {
    id: r.id,
    sentAt: r.sentAt,
    type: r.emailType || r.notificationType || "OTHER",
    isTest: r.isTest,
    status: r.status,
    errorMessage: r.errorMessage,
    to: r.recipientEmail,
    recipientUserId: r.recipientUserId,
    company: r.company ? { id: r.company.id, name: r.company.name } : null,
    from: r.fromAddress,
    subject: r.subject,
    messageId: r.messageId,
    accepted: r.accepted || [],
    rejected: r.rejected || [],
    smtpResponse: r.smtpResponse,
    triggeredBy: r.triggeredBy,
    sizeBytes: r.sizeBytes,
    redactedCount: r.redactedCount,
    copy: r.archiveKey ? (copyAvailable(r) ? "available" : "expired") : "none",
  };
}

function parseFilters(q = {}) {
  const to = q.to ? moment.utc(q.to, "YYYY-MM-DD", true) : moment.utc();
  const from = q.from ? moment.utc(q.from, "YYYY-MM-DD", true) : moment.utc(to).subtract(6, "days");
  if (!from.isValid() || !to.isValid()) throw new EmailLogError(400, "from and to must be dates (YYYY-MM-DD).");
  if (from.isAfter(to)) throw new EmailLogError(400, "from must be on or before to.");
  if (to.diff(from, "days") > MAX_RANGE_DAYS) throw new EmailLogError(400, `Pick at most ${MAX_RANGE_DAYS} days.`);
  const start = from.clone().startOf("day").toDate();
  const end = to.clone().endOf("day").toDate();

  const where = { sentAt: { gte: start, lte: end } };
  if (q.companyId) where.companyId = String(q.companyId);
  if (q.status) {
    if (!["sent", "failed"].includes(q.status)) throw new EmailLogError(400, "status must be sent or failed.");
    where.status = q.status;
  }
  if (q.type) where.emailType = String(q.type);
  if (q.isTest === "true") where.isTest = true;
  if (q.isTest === "false") where.isTest = false;
  if (q.q) {
    const s = String(q.q).trim().slice(0, 100);
    if (s) where.OR = [{ recipientEmail: { contains: s, mode: "insensitive" } }, { subject: { contains: s, mode: "insensitive" } }];
  }
  return { where, start, end, from: from.format("YYYY-MM-DD"), to: to.format("YYYY-MM-DD") };
}

/** GET /api/system-admin/emails — filters: from, to (UTC dates), companyId, type, status, isTest, q; page, pageSize. */
async function listEmails(query = {}) {
  const f = parseFilters(query);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 50, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  const [rows, total, byStatus, byType, byDayRows] = await Promise.all([
    prisma.emailNotificationLog.findMany({
      where: f.where,
      orderBy: { sentAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { company: { select: { id: true, name: true } } },
    }),
    prisma.emailNotificationLog.count({ where: f.where }),
    prisma.emailNotificationLog.groupBy({ by: ["status"], where: f.where, _count: { _all: true } }),
    prisma.emailNotificationLog.groupBy({ by: ["emailType"], where: f.where, _count: { _all: true } }),
    byDay(f),
  ]);

  const statusCount = (s) => byStatus.find((b) => b.status === s)?._count._all || 0;
  return {
    filters: { from: f.from, to: f.to, companyId: query.companyId || null, type: query.type || null, status: query.status || null, isTest: query.isTest ?? null, q: query.q || null },
    summary: {
      total,
      sent: statusCount("sent"),
      failed: statusCount("failed"),
      byType: byType
        .map((b) => ({ type: b.emailType || "OTHER", count: b._count._all }))
        .sort((a, b) => b.count - a.count),
      byDay: byDayRows,
    },
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map(shapeRow),
    retention: { copyDays: COPY_DAYS, summaryDays: SUMMARY_DAYS },
  };
}

/** Sent / failed per UTC day for the range (only the date + status filters, plus company/type/test). */
async function byDay(f) {
  const conds = [Prisma.sql`"sentAt" >= ${f.start}`, Prisma.sql`"sentAt" <= ${f.end}`];
  if (f.where.companyId) conds.push(Prisma.sql`"companyId" = ${f.where.companyId}`);
  if (f.where.emailType) conds.push(Prisma.sql`"emailType" = ${f.where.emailType}`);
  if (f.where.isTest !== undefined) conds.push(Prisma.sql`"isTest" = ${f.where.isTest}`);
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc('day', "sentAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           COUNT(*) FILTER (WHERE "status" = 'sent')::int AS sent,
           COUNT(*) FILTER (WHERE "status" = 'failed')::int AS failed
    FROM "EmailNotificationLog"
    WHERE ${Prisma.join(conds, " AND ")}
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ day: r.day, sent: r.sent, failed: r.failed }));
}

// ── Detail + image check ──────────────────────────────────────────────────────

function imageUrls(html) {
  if (!html) return [];
  const urls = new Set();
  const re = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && urls.size < MAX_IMAGES) urls.add(m[1].replace(/&amp;/g, "&"));
  const bg = /url\(\s*["']?(https?:\/\/[^"')\s]+)["']?\s*\)/gi;
  while ((m = bg.exec(html)) && urls.size < MAX_IMAGES) urls.add(m[1]);
  return [...urls];
}

// Only public http(s) hosts: never let the check reach the server's own network.
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return null; // IP literals
    return u;
  } catch {
    return null;
  }
}

async function checkImage(raw) {
  if (raw.startsWith("cid:")) return { url: raw, ok: null, reason: "Embedded attachment (not checked)" };
  if (raw.startsWith("data:image/")) return { url: raw.slice(0, 40) + "…", ok: true, reason: "Inline image" };
  const u = safeUrl(raw);
  if (!u) return { url: raw, ok: false, reason: "Not a public web address" };
  const attempt = async (method) => {
    const res = await fetch(u, { method, redirect: "follow", signal: AbortSignal.timeout(4000) });
    if (method === "GET") res.body?.cancel?.().catch?.(() => {});
    return res;
  };
  try {
    let res = await attempt("HEAD");
    if (res.status === 405 || res.status === 403) res = await attempt("GET");
    const type = res.headers.get("content-type") || "";
    const ok = res.ok && type.startsWith("image/");
    return { url: raw, ok, status: res.status, contentType: type || null, reason: ok ? null : res.ok ? "Not an image" : `HTTP ${res.status}` };
  } catch (e) {
    return { url: raw, ok: false, reason: e.name === "TimeoutError" ? "Timed out" : "Could not load" };
  }
}

/** GET /api/system-admin/emails/:id — summary + the stored copy + image check. */
async function getEmail(id) {
  const row = await prisma.emailNotificationLog.findUnique({
    where: { id: String(id) },
    include: { company: { select: { id: true, name: true } } },
  });
  if (!row) throw new EmailLogError(404, "Email not found.");
  const out = shapeRow(row);

  let copy = null;
  if (out.copy === "available" && s3.isConfigured("email")) {
    try {
      const raw = await s3.getObjectText(row.archiveKey, "email");
      if (raw) copy = JSON.parse(raw);
      else out.copy = "expired";
    } catch (e) {
      console.error("[BB-140] reading email copy failed:", e.message);
      out.copy = "unavailable";
    }
  }

  const images = copy?.html ? await Promise.all(imageUrls(copy.html).map(checkImage)) : [];
  return {
    ...out,
    legacyBody: row.body || null, // older rows: template data as JSON, no copy
    metadata: row.metadata || null,
    content: copy ? { from: copy.from, to: copy.to, subject: copy.subject, html: copy.html, text: copy.text } : null,
    images,
  };
}

module.exports = { recordEmail, listEmails, getEmail, EmailLogError, COPY_DAYS, SUMMARY_DAYS };
