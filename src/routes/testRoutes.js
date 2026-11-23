// routes/testRoutes.js (or add to your existing admin routes)
const express = require('express');
const router = express.Router();
const sendEveningReportTestJob = require('../jobs/sendEveningReportTestJob');
const { findTemplate } = require('@services/Analytics/emailTemplateCatalog');
const { withEmailContext } = require('@utils/emailContext');

// POST /api/test/trigger-evening-report
router.post('/trigger-evening-report', async (req, res) => {
  try {
    console.log('[TEST] Manually triggering evening report...');
    await sendEveningReportTestJob();
    res.json({ success: true, message: 'Evening report test triggered successfully!' });
  } catch (error) {
    console.error('[TEST] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// BB-144: sample emails. Each route sends the same sample as the System Admin
// test send (services/Analytics/emailTemplateCatalog.js), so the sample data
// lives in one place. "[TEST]" is added to the subject and the send is logged
// as a test (BB-140). Body: { "to": "someone@example.com" } (optional).
const SAMPLE_ROUTES = {
  '/clock-out-warning-email': 'clockOutWarning',
  '/auto-clock-out-sv-email': 'autoClockOutSv',
  '/missed-clock-in-email': 'missedClockIn',
  '/missed-clock-out-email': 'missedClockOut',
  '/auto-clock-out-email': 'autoClockOut',
  '/auto-clock-out-corrected-email': 'autoClockOutCorrected',
  '/morning-report-email': 'morningReport',
  '/evening-report-email': 'eveningReport',
};

for (const [path, key] of Object.entries(SAMPLE_ROUTES)) {
  router.post(path, async (req, res) => {
    const to = req.body?.to || 'webdev@bizsolutions.us';
    try {
      await withEmailContext({ isTest: true, triggeredBy: 'test-route' }, () => findTemplate(key).send(to));
      res.json({ success: true, message: `Sample "${key}" email sent to ${to}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = router;
