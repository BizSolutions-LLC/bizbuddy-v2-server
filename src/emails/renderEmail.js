// src/emails/renderEmail.js
//
// BB-144: one design for every email the server sends. The templates come from
// docs/BizBuddy-email-templates.zip (email-safe HTML, Handlebars placeholders),
// adapted in src/emails/templates/ (one file per email + templates.json with
// the subject and preview text of each).
//
// renderEmail(key, data) → { subject, preheader, html, text }
//   - data is merged over the shared footer values (support email/phone, web
//     address, logo address, year); company_name falls back to "your company".
//   - HTML is escaped by Handlebars (keep {{ }}, never {{{ }}}); the subject
//     and preview text are plain text (noEscape).
//   - text is a plain-text copy of the HTML, sent alongside it.
//
// Links and the logo address: see webUrl() / logoUrl() below.

const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

const DIR = path.join(__dirname, "templates");
const hbs = Handlebars.create();

let manifest = null;
const compiled = new Map();

function loadManifest() {
  if (!manifest) {
    manifest = JSON.parse(fs.readFileSync(path.join(DIR, "templates.json"), "utf8"));
  }
  return manifest;
}

/** The web app address used in every link (no trailing slash). */
function webUrl() {
  return (process.env.CLIENT_URL || process.env.FRONTEND_URL || "https://mybizbuddy.co").replace(/\/+$/, "");
}

/**
 * Public https address of the logo (Gmail and Outlook don't show attached
 * images). It is the web app's public/logo.png, live at mybizbuddy.co (the
 * client repo must keep that file, see docs/client-update-BB-144.md).
 * EMAIL_LOGO_URL may point elsewhere without a code change; if the image ever
 * fails to load, the email shows the orange "BizBuddy" alt text instead.
 */
const DEFAULT_LOGO_URL = "https://mybizbuddy.co/logo.png";
function logoUrl() {
  const url = (process.env.EMAIL_LOGO_URL || "").trim();
  return /^https:\/\//i.test(url) ? url : DEFAULT_LOGO_URL;
}

/** Web pages the emails link to (client routes, see docs/client-update-BB-144.md). */
const links = {
  signIn: () => `${webUrl()}/sign-in`,
  forgotPassword: () => `${webUrl()}/reset-password`,
  punch: () => `${webUrl()}/dashboard/employee/punch`,
  myPunchLogs: () => `${webUrl()}/dashboard/employee/punch-logs`,
  companyPunchLogs: () => `${webUrl()}/dashboard/company/punch-logs`,
};

function footerDefaults() {
  const defaults = loadManifest().footer_defaults || {};
  return {
    ...defaults,
    app_url: `${webUrl()}/`,
    logo_url: logoUrl(),
    year: new Date().getFullYear(),
    company_name: "your company",
  };
}

function compile(key) {
  if (compiled.has(key)) return compiled.get(key);
  const t = loadManifest().templates.find((x) => x.key === key);
  if (!t) throw new Error(`Unknown email template: ${key}`);
  const entry = {
    html: hbs.compile(fs.readFileSync(path.join(DIR, t.file), "utf8")),
    subject: hbs.compile(t.subject, { noEscape: true }),
    preheader: hbs.compile(t.preheader, { noEscape: true }),
  };
  compiled.set(key, entry);
  return entry;
}

// Empty strings / null fall back to the defaults instead of blanking them.
function merge(defaults, data) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined || v === null || v === "") {
      if (!(k in defaults)) out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&#x3D;": "=", "&#x60;": "`" };

/** Plain-text copy of an email (simple: keeps text, links and line breaks). */
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<head[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<div style="display:none;[\s\S]*?<\/div>/i, ""); // preview text
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    if (/^(mailto|tel):/i.test(href) || !label) return label;
    const url = href.replace(/&amp;/g, "&");
    return label === url ? url : `${label} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|h1|h2|tr|div)>/gi, "\n");
  s = s.replace(/<\/td>/gi, "  ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e] ?? (/^&#\d+;$/.test(e) ? "" : e));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join("\n")
    .trim();
}

/**
 * @param {string} key   template key (templates.json), e.g. "password-reset"
 * @param {object} data  template variables (snake_case, as in the ZIP)
 * @returns {{ subject: string, preheader: string, html: string, text: string }}
 */
function renderEmail(key, data = {}) {
  const t = compile(key);
  const ctx = merge(footerDefaults(), data);
  const subject = t.subject(ctx).trim();
  const preheader = t.preheader(ctx).trim();
  const html = t.html({ ...ctx, subject, preheader });
  return { subject, preheader, html, text: htmlToText(html) };
}

module.exports = { renderEmail, htmlToText, webUrl, logoUrl, links };
