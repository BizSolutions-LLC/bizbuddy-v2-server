const { sendMail } = require('@utils/mailer');
const { renderEmail } = require('@emails/renderEmail');

/**
 * Send an email built from one of the BB-144 templates (src/emails/templates).
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.templateKey - Template key in templates.json (e.g. "missed-clock-in")
 * @param {Object} options.data - Template variables (snake_case, see templates.json)
 * @param {string} [options.subject] - Overrides the template's subject
 * @param {boolean} options.isNotification - Use notification email (default: true for this service)
 * @param {Object} options.log - BB-140 logging info, passed to sendMail (type defaults to the template key)
 */
async function sendEmail({ to, subject, templateKey, data = {}, isNotification = true, log = {} }) {
  const logInfo = { type: templateKey, ...log };
  let finalSubject = subject || null;
  try {
    const email = renderEmail(templateKey, data);
    finalSubject = subject || email.subject;

    // Use notification email by default for this service
    await sendMail({
      to,
      subject: finalSubject,
      html: email.html,
      text: email.text,
      isNotification, // Will use notifications@mybizbuddy.co
      log: logInfo,
    });

    console.log(`✅ Email sent to: ${to} (from: ${isNotification ? 'notifications@' : 'no-reply@'})`);
    return { success: true };
  } catch (error) {
    console.error('❌ Email send failed:', error);
    // BB-140: a failure before sending (e.g. template error) is logged here;
    // a send failure was already logged by sendMail.
    if (!error.emailLogged) {
      const { recordEmail } = require('@services/Analytics/emailLogService');
      await recordEmail({ to, from: null, subject: finalSubject || templateKey, status: 'failed', error, log: logInfo });
    }
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendEmail,
};
