const { sendMail } = require('@utils/mailer');
const handlebars = require('handlebars');
const fs = require('fs').promises;
const path = require('path');

/**
 * Load and compile Handlebars template
 */
async function loadTemplate(templateName) {
  const templatePath = path.join(__dirname, '../templates', `${templateName}.hbs`);
  try {
    const templateSource = await fs.readFile(templatePath, 'utf-8');
    return handlebars.compile(templateSource);
  } catch (error) {
    console.error(`❌ Template not found: ${templateName}`, error);
    throw error;
  }
}

/**
 * Send email with template
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.templateName - Handlebars template name (without .hbs)
 * @param {Object} options.context - Template variables
 * @param {boolean} options.isNotification - Use notification email (default: true for this service)
 * @param {Object} options.log - BB-140 logging info, passed to sendMail (type defaults to the template name)
 */
async function sendEmail({ to, subject, templateName, context, isNotification = true, log = {} }) {
  const logInfo = { type: templateName, ...log };
  try {
    const template = await loadTemplate(templateName);
    const html = template(context);

    // Use notification email by default for this service
    await sendMail({ 
      to, 
      subject, 
      html,
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
      await recordEmail({ to, from: null, subject, status: 'failed', error, log: logInfo });
    }
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendEmail,
};