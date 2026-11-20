const cron = require('node-cron');

const checkMissedClockIns            = require('../jobs/checkMissedClockIns');
const checkMissedClockOuts           = require('../jobs/checkMissedClockOuts');
const sendMorningReportJob           = require('../jobs/sendMorningReport');
const sendEveningReportJob           = require('../jobs/sendEveningReport');
const autoClockOutJob                = require('../jobs/autoClockOutJob');
const autoGenerateCutoffPeriodsJob   = require('../jobs/autoGenerateCutoffPeriodsJob');
const notificationRetentionJob       = require('../jobs/notificationRetentionJob');
const breadcrumbRetentionJob         = require('../jobs/breadcrumbRetentionJob');
const emailLogRetentionJob           = require('../jobs/emailLogRetentionJob');
const loginEventRetentionJob         = require('../jobs/loginEventRetentionJob');

/**
 * Initialize all cron jobs for the notification system
 */
function initializeCronJobs() {
  // Job 1: Check for missed clock-ins every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkMissedClockIns();
  });

  // Job 2: Check for missed clock-outs every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkMissedClockOuts();
  });

  // Job 3: Auto clock-out — two-pass warn + close (v2.7.3 redesign)
  cron.schedule('*/5 * * * *', async () => {
    await autoClockOutJob();
  });

  // Jobs 4 + 5: morning / evening attendance reports. BB-117: checked every 5
  // minutes; each company gets its report at its own Notification Settings time
  // (morningReportTime / eveningReportTime) in its own time zone, once per day.
  // (Was a fixed 10:00 / 18:00 in the server's clock, which is UTC on Render.)
  cron.schedule('*/5 * * * *', async () => {
    await sendMorningReportJob();
    await sendEveningReportJob();
  });

  // Job 6: Auto-generate cutoff periods at 2:00 AM daily
  // Ensures each department always has at least 2 open future periods ahead.
  cron.schedule('0 2 * * *', async () => {
    await autoGenerateCutoffPeriodsJob();
  });

  // Job 7 (BB-117): notification retention, nightly at 03:30 server time.
  // Report-only until NOTIFICATION_RETENTION=on.
  cron.schedule('30 3 * * *', async () => {
    await notificationRetentionJob();
  });

  // Job 8 (BB-128 part 2): GPS breadcrumbs older than 90 days, nightly at 03:45 server time.
  cron.schedule('45 3 * * *', async () => {
    await breadcrumbRetentionJob();
  });

  // Job 9 (BB-140): email summary rows older than 1 year, nightly at 03:55 server time.
  // (Email copies in S3 expire after 90 days by the bucket rule.)
  cron.schedule('55 3 * * *', async () => {
    await emailLogRetentionJob();
  });

  // Job 10 (BB-137): login history older than 1 year, nightly at 04:05 server time.
  cron.schedule('5 4 * * *', async () => {
    await loginEventRetentionJob();
  });
}

module.exports = { initializeCronJobs };