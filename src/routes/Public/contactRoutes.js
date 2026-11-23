// src/routes/Public/contactRoutes.js
//
// BB-145: POST /api/public/contact (no sign-in). Landing page contact form.
// The 16 KB body limit is set in app.js (it parses JSON before the routes).
// Per-IP limits: 5 per hour and 20 per day. Only accepted requests (2xx,
// including silently dropped bots) count, so a visitor fixing a typo isn't
// blocked. The 200-a-day total for everyone is in contactFormService.

const express = require("express");
const rateLimit = require("express-rate-limit");
const logger = require("@config/logger");
const { handleContact, ContactFormError } = require("@services/Public/contactFormService");

const router = express.Router();

const RATE_LIMITED = { code: "RATE_LIMITED", message: "Too many messages. Please try again later." };

function limiter(windowMs, limit, scope) {
  return rateLimit({
    windowMs,
    limit,
    skipFailedRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const reset = req.rateLimit?.resetTime;
      const seconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : Math.ceil(windowMs / 1000);
      logger.warn(`[contact-form] outcome=rate-limited scope=${scope} ip=${req.ip || "-"}`);
      res.set("Retry-After", String(seconds));
      res.status(429).json(RATE_LIMITED);
    },
  });
}

const perHour = limiter(60 * 60 * 1000, 5, "ip-hour");
const perDay = limiter(24 * 60 * 60 * 1000, 20, "ip-day");

router.post("/contact", perDay, perHour, async (req, res) => {
  try {
    await handleContact(req.body, { ip: req.ip });
    // Sent and silently dropped look the same to the caller.
    return res.status(202).json({ ok: true });
  } catch (err) {
    if (err instanceof ContactFormError) {
      if (err.status === 429) {
        res.set("Retry-After", String(err.retryAfter || 3600));
        return res.status(429).json(RATE_LIMITED);
      }
      if (err.status === 400) {
        return res.status(400).json({ code: err.code, message: err.message, fields: err.fields || {} });
      }
    }
    if (!(err instanceof ContactFormError)) {
      logger.error(`[contact-form] outcome=failed ip=${req.ip || "-"} error=${err.message}`);
    }
    return res.status(500).json({ code: "CONTACT_FAILED", message: "We couldn't send your message. Please email us directly." });
  }
});

module.exports = router;
