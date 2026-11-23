// src/services/Public/contactFormService.js
//
// BB-145: the public contact form on the landing page (POST /api/public/contact).
// The message is emailed to the team inbox (env CONTACT_FORM_TO), Reply-To =
// the visitor. No auto-reply to the visitor (their address isn't verified), no
// table: the Emails log (BB-140) is the record.
//
// CONTACT_FORM_TO: one or more addresses, comma separated. The first one is
// the visible "To"; the rest get a hidden copy (Bcc), so "Reply all" never
// shows the visitor the other internal addresses.
//
// Bots are dropped silently (the route still answers 202): honeypot filled in,
// sent under 3 s after the form appeared, or more than 3 links.
// Per-IP limits live on the route (routes/Public/contactRoutes.js); the daily
// cap for everyone together (DAILY_SEND_CAP sent emails per LA day) is here,
// in memory, so it starts again at zero after a restart.

const moment = require("moment-timezone");
const logger = require("@config/logger");
const { sendMail } = require("@utils/mailer");
const { renderEmail } = require("@emails/renderEmail");

const ZONE = "America/Los_Angeles";
const DAILY_SEND_CAP = 200;
const MIN_FILL_MS = 3000;
const MAX_LINKS = 3;

const MESSAGES = {
  name: "Enter your name (up to 100 characters, one line).",
  email: "Enter a valid email address.",
  company: "Keep the company name to one line, up to 150 characters.",
  phone: "Enter a valid phone number.",
  teamSize: "Keep team size to 20 characters.",
  message: "Write a message of 10 to 5,000 characters.",
};

// One @, no spaces, commas, quotes or angle brackets, a dotted domain.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
// Optional phone: digits, spaces, + ( ) - . and an extension ("x12", "ext. 12"), 7–15 digits.
const PHONE_RE = /^\+?[0-9 ().-]+(?:\s*(?:x|ext\.?)\s*[0-9]{1,6})?$/i;
const LINK_RE = /\bhttps?:\/\/|\bwww\./gi;

class ContactFormError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Trimmed string, "" when missing; undefined when the value isn't text. */
function text(v) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return undefined;
  return v.trim();
}

/** Phone format + 7–15 digits in the number itself (extension not counted). */
function validPhone(s) {
  if (!PHONE_RE.test(s)) return false;
  const digits = s.replace(/\s*(?:x|ext\.?)\s*[0-9]+$/i, "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Checks the body. Unknown fields are ignored and never passed along.
 * @returns {{ name, email, company, phone, teamSize, message }}  (throws 400 otherwise)
 */
function validate(body = {}) {
  const v = {
    name: text(body.name),
    email: text(body.email),
    company: text(body.company),
    phone: text(body.phone),
    teamSize: text(body.teamSize),
    message: text(body.message),
  };
  const bad = {};
  const oneLine = (s) => s !== undefined && !LINE_BREAK.test(s);

  if (!oneLine(v.name) || v.name.length < 1 || v.name.length > 100) bad.name = MESSAGES.name;
  if (!oneLine(v.email) || v.email.length > 254 || !EMAIL_RE.test(v.email)) bad.email = MESSAGES.email;
  if (!oneLine(v.company) || v.company.length > 150) bad.company = MESSAGES.company;
  if (!oneLine(v.phone) || v.phone.length > 30 || (v.phone && !validPhone(v.phone))) bad.phone = MESSAGES.phone;
  if (!oneLine(v.teamSize) || v.teamSize.length > 20) bad.teamSize = MESSAGES.teamSize;
  if (v.message === undefined || v.message.length < 10 || v.message.length > 5000) bad.message = MESSAGES.message;

  if (Object.keys(bad).length) {
    throw new ContactFormError(400, "VALIDATION_ERROR", "Please check the highlighted fields.", { fields: bad });
  }
  return v;
}

/**
 * Why the request looks like a bot (null = looks human).
 * "Too fast": elapsedMs (measured on the visitor's own clock) is preferred.
 * startedAt compares the visitor's clock with ours, so it only drops a result
 * between 0 and 3 s; a negative difference (visitor's clock ahead) is not
 * treated as a bot.
 */
function botReason(body = {}, v) {
  if (typeof body.website === "string" ? body.website.trim() !== "" : body.website != null && body.website !== "") {
    return "honeypot";
  }
  const elapsed = Number(body.elapsedMs);
  if (body.elapsedMs != null && Number.isFinite(elapsed)) {
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return "too-fast";
  } else if (body.startedAt != null && Number.isFinite(Number(body.startedAt))) {
    const diff = Date.now() - Number(body.startedAt);
    if (diff >= 0 && diff < MIN_FILL_MS) return "too-fast";
  }
  const links = [v.name, v.company, v.teamSize, v.message].join("\n").match(LINK_RE);
  if (links && links.length > MAX_LINKS) return "links";
  return null;
}

// ── Daily cap for everyone together (sent emails only) ──────────────────────
let capDay = null;
let capCount = 0;

function capState() {
  const day = moment.tz(ZONE).format("YYYY-MM-DD");
  if (day !== capDay) {
    capDay = day;
    capCount = 0;
  }
  return capCount;
}

function secondsUntilTomorrow() {
  const now = moment.tz(ZONE);
  return Math.max(60, Math.ceil(now.clone().add(1, "day").startOf("day").diff(now) / 1000));
}

/** Recipients from CONTACT_FORM_TO (comma or semicolon separated). */
function recipients() {
  return String(process.env.CONTACT_FORM_TO || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
}

/**
 * Renders and sends the team email. Used by the route and by the System Admin
 * test send (BB-140 catalog), which passes its own `to`.
 * @param {{ name, email, company, phone, teamSize, message }} v  checked fields
 * @param {{ to?: string[], ip?: string, triggeredBy?: string }} opts  (no triggeredBy:
 *   a System Admin test send is credited to that admin by the email context)
 */
async function sendContactEmail(v, { to, ip, triggeredBy = null } = {}) {
  const list = to && to.length ? to : recipients();
  if (!list.length) {
    throw new ContactFormError(500, "CONTACT_FAILED", "CONTACT_FORM_TO is not set.");
  }
  const who = v.company || v.name;
  const { subject, html, text: plain } = renderEmail("contact-form", {
    name: v.name,
    first_name: v.name.split(/\s+/)[0],
    email: v.email,
    company: v.company,
    phone: v.phone,
    // tel: link: the number without the extension, digits and a leading +.
    phone_link: v.phone ? v.phone.replace(/\s*(?:x|ext\.?)\s*[0-9]+$/i, "").replace(/(?!^\+)[^0-9]/g, "") : "",
    team_size: v.teamSize,
    message_lines: v.message.split(/\r\n|\r|\n/),
    inquirer: who.slice(0, 120 - "Website inquiry: ".length),
    sent_at: moment.tz(ZONE).format("ddd, MMM D, YYYY · h:mm A z"),
  });

  await sendMail({
    to: list[0],
    bcc: list.slice(1),
    replyTo: { name: v.name, address: v.email },
    subject: subject.slice(0, 120),
    html,
    text: plain,
    log: {
      type: "CONTACT_FORM",
      triggeredBy,
      metadata: { source: "contact-form", ip: ip || null, replyTo: v.email, company: v.company || null, teamSize: v.teamSize || null },
    },
  });
}

/**
 * The whole request: validate → bot check → daily cap → send.
 * @returns {{ outcome: "sent" | "dropped", reason?: string }}
 * Throws ContactFormError (400 / 429 / 500).
 */
async function handleContact(body, { ip } = {}) {
  const v = validate(body || {});

  const reason = botReason(body || {}, v);
  if (reason) {
    logger.info(`[contact-form] outcome=dropped reason=${reason} ip=${ip || "-"}`);
    return { outcome: "dropped", reason };
  }

  if (capState() >= DAILY_SEND_CAP) {
    logger.warn(`[contact-form] outcome=rate-limited scope=daily-total ip=${ip || "-"}`);
    throw new ContactFormError(429, "RATE_LIMITED", "Too many messages. Please try again later.", {
      retryAfter: secondsUntilTomorrow(),
    });
  }

  try {
    await sendContactEmail(v, { ip, triggeredBy: "contact-form" });
  } catch (err) {
    logger.error(`[contact-form] outcome=failed ip=${ip || "-"} error=${err.message}`);
    throw new ContactFormError(500, "CONTACT_FAILED", "We couldn't send your message. Please email us directly.");
  }
  capState();
  capCount += 1;
  logger.info(`[contact-form] outcome=sent ip=${ip || "-"}`);
  return { outcome: "sent" };
}

module.exports = { handleContact, sendContactEmail, validate, botReason, ContactFormError, DAILY_SEND_CAP };
