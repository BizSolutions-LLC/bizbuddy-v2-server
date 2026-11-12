// src/jobs/notificationRetentionJob.js
//
// BB-117: nightly cleanup of old notifications (docs/changelog-v2.11.7.md).
//   - read notifications older than 90 days
//   - any notification older than 180 days
//   - hidden (deleted in the app) notifications 30 days after they were hidden
//   - old reminder markers (UserActivity "clockinReminder:" / "clockoutReminder:",
//     written before BB-117) older than 7 days
//
// REPORT-ONLY unless NOTIFICATION_RETENTION=on: it logs how many rows each rule
// would delete and deletes nothing. Check the first nights' counts in the logs,
// then set the variable to switch deleting on. Deletes run in batches so the
// tables are never locked for long.

const { prisma } = require("@config/connection");

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 5000;
const RULES = { readDays: 90, anyDays: 180, hiddenDays: 30, markerDays: 7 };

const enabled = () => String(process.env.NOTIFICATION_RETENTION || "").toLowerCase() === "on";

async function deleteInBatches(model, where) {
  let total = 0;
  for (;;) {
    const rows = await prisma[model].findMany({ where, select: { id: true }, take: BATCH });
    if (!rows.length) break;
    const { count } = await prisma[model].deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += count;
    if (rows.length < BATCH) break;
  }
  return total;
}

async function notificationRetentionJob() {
  const now = Date.now();
  const before = (days) => new Date(now - days * DAY);

  const rules = [
    { label: `read, older than ${RULES.readDays} days`, model: "notificationLog", where: { seen: true, createdAt: { lt: before(RULES.readDays) } } },
    { label: `any, older than ${RULES.anyDays} days`, model: "notificationLog", where: { createdAt: { lt: before(RULES.anyDays) } } },
    { label: `hidden more than ${RULES.hiddenDays} days ago`, model: "notificationLog", where: { deletedAt: { lt: before(RULES.hiddenDays) } } },
    {
      label: `reminder markers older than ${RULES.markerDays} days`,
      model: "userActivity",
      where: {
        createdAt: { lt: before(RULES.markerDays) },
        OR: [
          { activityDescription: { startsWith: "clockinReminder:" } },
          { activityDescription: { startsWith: "clockoutReminder:" } },
        ],
      },
    },
  ];

  try {
    const mode = enabled() ? "DELETING" : "REPORT-ONLY (set NOTIFICATION_RETENTION=on to delete)";
    for (const rule of rules) {
      if (enabled()) {
        const deleted = await deleteInBatches(rule.model, rule.where);
        console.log(`[BB-117 retention] ${mode} · ${rule.label}: ${deleted} deleted`);
      } else {
        const count = await prisma[rule.model].count({ where: rule.where });
        console.log(`[BB-117 retention] ${mode} · ${rule.label}: ${count} would be deleted`);
      }
    }
  } catch (err) {
    console.error("[BB-117 retention] error:", err);
  }
}

module.exports = notificationRetentionJob;
