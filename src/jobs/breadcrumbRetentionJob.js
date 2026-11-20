// src/jobs/breadcrumbRetentionJob.js
//
// BB-128 part 2: nightly cleanup of GPS breadcrumbs older than 90 days
// (user decision 2026-11-18). Deletes in batches so the table is never locked
// for long. Clock-in / clock-out locations on TimeLog are not touched.

const { prisma } = require("@config/connection");
const { RETENTION_DAYS } = require("@services/Locations/breadcrumbService");

const BATCH = 5000;

async function breadcrumbRetentionJob() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;
  try {
    for (;;) {
      const rows = await prisma.locationBreadcrumb.findMany({
        where: { recordedAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const { count } = await prisma.locationBreadcrumb.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += count;
      if (rows.length < BATCH) break;
    }
    console.log(`[BB-128] Breadcrumb retention: deleted ${total} point(s) recorded before ${cutoff.toISOString()}`);
  } catch (err) {
    console.error("[BB-128] Breadcrumb retention failed:", err.message);
  }
}

module.exports = breadcrumbRetentionJob;
