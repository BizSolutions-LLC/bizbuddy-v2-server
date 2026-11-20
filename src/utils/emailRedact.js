// src/utils/emailRedact.js
//
// BB-140: hide sensitive values in an email before a copy is stored.
//   1. Values the sender marks (passwords, one-time codes, reset tokens) are
//      replaced everywhere they appear, plain or HTML-escaped.
//   2. Safety net: the value of any URL query parameter that looks secret
//      (token, code, otp, key, secret, password, reset…) is replaced too.
// Returns the redacted parts and how many replacements were made.

const MASK = "••••••";

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SECRET_PARAM = /([?&](?:token|code|otp|key|secret|password|pass|reset)[a-z_]*=)([^&"'\s<>#]+)/gi;

function redactEmail({ subject = "", html = "", text = "" }, secrets = []) {
  let count = 0;
  const values = [...new Set(
    (Array.isArray(secrets) ? secrets : [])
      .filter((s) => s !== null && s !== undefined)
      .map(String)
      .filter((s) => s.length >= 4)
  )].sort((a, b) => b.length - a.length); // longest first, so a substring never splits a longer secret

  const scrub = (input) => {
    if (!input) return input;
    let out = String(input);
    for (const v of values) {
      for (const variant of new Set([v, escapeHtml(v), encodeURIComponent(v)])) {
        const parts = out.split(variant);
        if (parts.length > 1) {
          count += parts.length - 1;
          out = parts.join(MASK);
        }
      }
    }
    out = out.replace(SECRET_PARAM, (m, name, value) => {
      if (value === MASK || value === encodeURIComponent(MASK)) return m;
      count += 1;
      return `${name}${MASK}`;
    });
    return out;
  };

  return { subject: scrub(subject), html: scrub(html), text: scrub(text), count };
}

module.exports = { redactEmail, MASK };
