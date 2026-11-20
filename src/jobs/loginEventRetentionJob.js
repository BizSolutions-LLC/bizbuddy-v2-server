// src/jobs/loginEventRetentionJob.js
//
// BB-137: nightly cleanup of LoginEvent rows older than 1 year (user decision
// 2026-11-20). Deletes in batches so the table is never locked for long.

const { prisma } = require("@config/connection");

const RETENTION_DAYS = 365;
const BATCH = 5000;

async function loginEventRetentionJob() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let total = 0;
  try {
    for (;;) {
      const rows = await prisma.loginEvent.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (!rows.length) break;
      const { count } = await prisma.loginEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      total += count;
      if (rows.length < BATCH) break;
    }
    console.log(`[BB-137] Login event retention: deleted ${total} row(s) before ${cutoff.toISOString()}`);
  } catch (err) {
    console.error("[BB-137] Login event retention failed:", err.message);
  }
}

module.exports = loginEventRetentionJob;
