// src/jobs/emailLogRetentionJob.js
//
// BB-140: nightly cleanup of email summary rows (EmailNotificationLog) older
// than 1 year. The email copies in S3 are deleted after 90 days by the bucket's
// own lifecycle rule, not here. Deletes in batches so the table is never locked
// for long.

const { prisma } = require("@config/connection");
const { SUMMARY_DAYS } = require("@services/Analytics/emailLogService");

const BATCH = 5000;

async function emailLogRetentionJob() {
  const cutoff = new Date(Date.now() - SUMMARY_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;
  try {
    for (;;) {
      const rows = await prisma.emailNotificationLog.findMany({
        where: { sentAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const { count } = await prisma.emailNotificationLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += count;
      if (rows.length < BATCH) break;
    }
    console.log(`[BB-140] Email log retention: deleted ${total} row(s) sent before ${cutoff.toISOString()}`);
  } catch (err) {
    console.error("[BB-140] Email log retention failed:", err.message);
  }
}

module.exports = emailLogRetentionJob;
