const { prisma } = require('@config/connection');
const { sendEveningReport } = require('@services/notificationService');
const { buildEveningReport } = require('./sendEveningReport');
const moment = require('moment-timezone');

const TEST_EMAIL = 'webdev@bizsolutions.us';

/**
 * TEST VERSION of the evening report job.
 * Sends only to TEST_EMAIL regardless of company admin settings, every company
 * with the report switched on, even when there is nothing to report.
 *
 * BB-144: builds the report with the real job's builder (sendEveningReport.js),
 * so the test shows exactly what admins receive.
 */
async function sendEveningReportTestJob() {
  console.log('[TEST] Generating evening reports...');

  try {
    const companies = await prisma.company.findMany({
      where: { notifyAdminMissedClocks: true },
      select: {
        id: true,
        name: true,
        timeZone: true,
      },
    });

    for (const company of companies) {
      const timeZone = moment.tz.zone(company.timeZone || '') ? company.timeZone : 'America/Los_Angeles';
      const now = moment().tz(timeZone);
      const dateKey = now.format('YYYY-MM-DD');

      const report = await buildEveningReport({ id: company.id, timeZone, now, dateKey });

      console.log(
        `[TEST] Sending evening report for ${company.name} ` +
        `(${report.open.length} open, ${report.autoOut.length} auto, ${report.absent.length} no-shows) → ${TEST_EMAIL}`
      );

      await sendEveningReport(company.id, report, { testEmail: TEST_EMAIL, dateKey });
    }

    console.log('[TEST] Evening reports complete.');
  } catch (error) {
    console.error('[TEST] Error sending evening reports:', error);
  }
}

module.exports = sendEveningReportTestJob;
