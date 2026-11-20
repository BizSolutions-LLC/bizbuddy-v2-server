// src/utils/mailer.js
const nodemailer = require("nodemailer");
const { emailContext } = require("@utils/emailContext"); // BB-140

const host = process.env.SMTP_HOST || "smtp.dreamhost.com";
const port = Number(process.env.SMTP_PORT || 587);
const secure = port === 465;

// Default transporter (existing no-reply email)
const defaultTransporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Notification transporter (new notifications email)
const notificationTransporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: {
    user: process.env.NOTIFICATION_SMTP_USER,
    pass: process.env.NOTIFICATION_SMTP_PASS,
  },
});

// Verify both connections on startup
defaultTransporter.verify((error, success) => {
  if (error) {
    console.error('❌ Default email service error:', error);
  } else {
    console.log('✅ Default email service ready (no-reply@mybizbuddy.co)');
  }
});

notificationTransporter.verify((error, success) => {
  if (error) {
    console.error('❌ Notification email service error:', error);
  } else {
    console.log('✅ Notification email service ready (notifications@mybizbuddy.co)');
  }
});

/**
 * Send email using appropriate transporter
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content (optional)
 * @param {boolean} options.isNotification - Use notification email (default: false)
 * @param {string} options.from - Custom from address (optional)
 * @param {Object} options.log - BB-140: how to log it (all optional):
 *   { type, notificationType, companyId, userId, triggeredBy, metadata,
 *     redact: [values to hide in the stored copy: passwords, codes, tokens] }
 *
 * BB-140: every email is logged (EmailNotificationLog + a redacted copy in S3)
 * by services/Analytics/emailLogService.recordEmail, sent or failed. Logging
 * never blocks or fails the email. Inside a System Admin test send
 * (utils/emailContext isTest) the subject gets a "[TEST] " prefix.
 */
async function sendMail({ to, subject, html, text, isNotification = false, from, log = {} }) {
  // Choose transporter
  const transporter = isNotification ? notificationTransporter : defaultTransporter;

  // Choose from address
  const fromAddress = from || (isNotification
    ? process.env.NOTIFICATION_MAIL_FROM
    : process.env.MAIL_FROM) || process.env.SMTP_USER;

  const { isTest } = emailContext();
  const finalSubject = isTest && !/^\[TEST\]/.test(subject || "") ? `[TEST] ${subject}` : subject;

  // Lazy: the log service loads Prisma; keep this util light for scripts.
  const { recordEmail } = require("@services/Analytics/emailLogService");
  const base = { to, from: fromAddress, subject: finalSubject, html, text, log };

  let info;
  try {
    info = await transporter.sendMail({
      from: fromAddress,
      to,
      subject: finalSubject,
      html,
      text,
    });
  } catch (error) {
    await recordEmail({ ...base, status: "failed", error });
    error.emailLogged = true; // callers that log failures themselves can skip it
    throw error;
  }
  await recordEmail({ ...base, status: "sent", info });
  return info;
}

module.exports = { 
  sendMail,
  defaultTransporter,
  notificationTransporter,
};