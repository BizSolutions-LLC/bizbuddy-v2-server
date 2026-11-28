// src/services/Cutoff/cutoffStatusEventService.js
//
// BB-149 follow-up: cutoff status history + reopening a processed cutoff.
//
// Table "CutoffStatusEvent" (scripts/add-cutoff-status-events-bb149.sql): one row per
// status change, with who (User.id + B. Buddy staff id) and, for a reopen, the reason.
// Raw SQL (like PayrollExportBatch), so it doesn't depend on the generated Prisma client.
//
//   - recordStatusEvent: best effort for normal changes and Finalize (never blocks a status change);
//     the reopen writes its row inside the reopen transaction instead (an audit row is required).
//   - historyFor: status history per cutoff, oldest first, with actor names.
//   - outdatedExports: which company+period payroll exports were built BEFORE a later
//     reopen of one of their departments (the export still holds the old numbers).

const moment = require("moment-timezone");
const { prisma } = require("@config/connection");
const { Prisma } = require("@prisma/client");

const ymd = (d) => new Date(d).toISOString().slice(0, 10); // cutoff dates are UTC calendar dates

/** Normal status change (open/locked/processed). Logged, never throws. */
async function recordStatusEvent({ cutoffPeriodId, companyId, fromStatus, toStatus, actor, action = "status", reason = null }, db = prisma) {
  try {
    await db.$executeRaw`
      INSERT INTO "CutoffStatusEvent" ("cutoffPeriodId", "companyId", "fromStatus", "toStatus", "action", "reason", "actorId", "agentId")
      VALUES (${cutoffPeriodId}, ${companyId}, ${fromStatus}, ${toStatus}, ${action}, ${reason}, ${actor?.id || null}, ${actor?.agentId || null})`;
  } catch (err) {
    console.error("[BB-149] cutoff status event not recorded:", err.message);
  }
}

/**
 * Status history for these cutoffs, oldest first.
 * @returns {Promise<Map<cutoffPeriodId, Array<{ fromStatus, toStatus, action, reason, at, by: { id, name }|null, bySupport }>>>}
 */
async function historyFor(cutoffPeriodIds) {
  const out = new Map(cutoffPeriodIds.map((id) => [id, []]));
  if (!cutoffPeriodIds.length) return out;
  let rows = [];
  try {
    rows = await prisma.$queryRaw`
      SELECT e."cutoffPeriodId", e."fromStatus", e."toStatus", e."action", e."reason", e."createdAt", e."actorId", e."agentId",
             p."firstName", p."lastName", u."email", u."isSystemAgent",
             sa."code" AS "agentCode"
      FROM "CutoffStatusEvent" e
      LEFT JOIN "User" u ON u."id" = e."actorId"
      LEFT JOIN "UserProfile" p ON p."userId" = u."id"
      LEFT JOIN "SupportAgent" sa ON sa."id" = e."agentId"
      WHERE e."cutoffPeriodId" IN (${Prisma.join(cutoffPeriodIds)})
      ORDER BY e."createdAt" ASC, e."id" ASC`;
  } catch (err) {
    // Table not created yet (SQL not run): no history, nothing else breaks.
    console.error("[BB-149] cutoff status history unavailable:", err.message);
    return out;
  }
  for (const r of rows) {
    // BB-151 follow-up: support events read "B. Buddy (123)" — last 3
    // characters of the staff code only (same as settings history).
    const supportCode = r.isSystemAgent && r.agentCode ? String(r.agentCode).slice(-3) : null;
    const name = r.isSystemAgent
      ? (supportCode ? `B. Buddy (${supportCode})` : "B. Buddy")
      : `${r.firstName || ""} ${r.lastName || ""}`.trim() || r.email || null;
    out.get(r.cutoffPeriodId)?.push({
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      action: r.action,
      reason: r.reason,
      at: r.createdAt,
      by: r.actorId ? { id: r.actorId, name } : null,
      bySupport: !!r.isSystemAgent, // B. Buddy (support staff id stays in the audit log)
      supportCode,
    });
  }
  return out;
}

/** Summary fields for one cutoff's history (for list/detail responses). */
function historySummary(events = []) {
  const reopens = events.filter((e) => e.action === "reopen");
  const last = reopens[reopens.length - 1] || null;
  return {
    reopenCount: reopens.length,
    lastReopen: last ? { at: last.at, by: last.by, bySupport: last.bySupport, supportCode: last.supportCode, reason: last.reason } : null,
  };
}

/**
 * Payroll exports (one per company + period, all departments) that still hold a
 * reopened department's old numbers: one of the period's department cutoffs was
 * reopened and is not processed again yet. Processing it again rebuilds its part
 * of the export, which clears it. (Not by generatedAt: processing ANOTHER department
 * rewrites the export but keeps the reopened department's old summary in it.)
 * @param {string} companyId
 * @param {Array<{ periodStart, periodEnd, generatedAt }>} batches  PayrollExportBatch rows
 * @returns {Promise<Map<"YYYY-MM-DD_YYYY-MM-DD", { reopenedAt, departments: string[] }>>}
 */
async function outdatedExports(companyId, batches) {
  const out = new Map();
  if (!batches.length) return out;
  let rows = [];
  try {
    rows = await prisma.$queryRaw`
      SELECT c."periodStart", c."periodEnd", c."status", d."name" AS "department", MAX(e."createdAt") AS "reopenedAt"
      FROM "CutoffStatusEvent" e
      JOIN "CutoffPeriod" c ON c."id" = e."cutoffPeriodId"
      LEFT JOIN "Department" d ON d."id" = c."departmentId"
      WHERE e."companyId" = ${companyId} AND e."action" = 'reopen'
      GROUP BY c."id", c."periodStart", c."periodEnd", c."status", d."name"`;
  } catch (err) {
    return out; // table not created yet
  }
  for (const b of batches) {
    const key = `${ymd(b.periodStart)}_${ymd(b.periodEnd)}`;
    for (const r of rows) {
      if (`${ymd(r.periodStart)}_${ymd(r.periodEnd)}` !== key) continue;
      if (r.status === "processed") continue; // processed again → its part was rebuilt
      const cur = out.get(key) || { reopenedAt: r.reopenedAt, departments: [] };
      if (new Date(r.reopenedAt) > new Date(cur.reopenedAt)) cur.reopenedAt = r.reopenedAt;
      cur.departments.push(r.department || "(company-wide)");
      out.set(key, cur);
    }
  }
  return out;
}

/** Has this cutoff been reopened before (so processing again = "Payroll Updated")? */
async function wasReopened(cutoffPeriodId) {
  try {
    const [r] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n FROM "CutoffStatusEvent"
      WHERE "cutoffPeriodId" = ${cutoffPeriodId} AND "action" = 'reopen'`;
    return (r?.n || 0) > 0;
  } catch (_) {
    return false;
  }
}

/** Payment date reached in the company zone (cutoff dates are UTC calendar dates). */
function paymentDateReached(paymentDate, companyTz) {
  if (!paymentDate) return false;
  const today = moment.tz(companyTz || "America/Los_Angeles").format("YYYY-MM-DD");
  return ymd(paymentDate) <= today;
}

module.exports = { recordStatusEvent, historyFor, historySummary, outdatedExports, wasReopened, paymentDateReached, ymd };
