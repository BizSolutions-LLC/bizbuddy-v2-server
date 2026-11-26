const crypto = require("crypto");
const { prisma } = require("@config/connection");
const { checkBatchShape, classifySample, cleanSource, cleanBatteryLevel } = require("./locationBreadcrumbRules");
const { markAnswered } = require("./locateRequestService"); // BB-128 phase 3b

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const pairKey = (timeLogId, recordedAt) => `${timeLogId}|${recordedAt.getTime()}`;

/**
 * Saves one upload batch (BB-128). Response is one result per sample, in order:
 * saved | duplicate | rejected (+ reason). Since 2026-11-25 the batch is written
 * with ONE insert (was one insert per sample); duplicates are found up front
 * (already stored, or repeated inside the batch) so the per-sample answer is the same.
 */
async function saveBreadcrumbs(user, body) {
  const shaped = checkBatchShape(body);
  if (shaped.error) return shaped;

  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { breadcrumbsEnabled: true },
  });
  if (!company || company.breadcrumbsEnabled !== true) {
    return { error: { status: 403, message: "Location logging is off for this company.", code: "BREADCRUMBS_DISABLED" } };
  }

  const ids = [...new Set(shaped.samples.map((s) => (s && typeof s.timeLogId === "string" ? s.timeLogId : null)).filter(Boolean))];
  const logs = ids.length
    ? await prisma.timeLog.findMany({
        where: { id: { in: ids }, userId: user.id },
        select: { id: true, timeIn: true, timeOut: true },
      })
    : [];
  const byId = new Map(logs.map((log) => [log.id, log]));
  const now = new Date();

  // 1. Validate every sample.
  const results = new Array(shaped.samples.length);
  const accepted = []; // { index, sample, recordedAt }
  shaped.samples.forEach((sample, index) => {
    const decision = classifySample(sample, byId.get(sample && sample.timeLogId), now);
    if (decision.status !== "ok") results[index] = { status: "rejected", reason: decision.reason };
    else accepted.push({ index, sample, recordedAt: decision.recordedAt });
  });

  if (!accepted.length) return { results };

  // 2. Points already stored for these punches at these times.
  const existing = await prisma.locationBreadcrumb.findMany({
    where: {
      timeLogId: { in: [...new Set(accepted.map((a) => a.sample.timeLogId))] },
      recordedAt: { in: accepted.map((a) => a.recordedAt) },
    },
    select: { timeLogId: true, recordedAt: true },
  });
  const seen = new Set(existing.map((r) => pairKey(r.timeLogId, r.recordedAt)));

  // 3. One insert for the new ones. skipDuplicates covers a retry racing this one.
  const rows = [];
  for (const { index, sample, recordedAt } of accepted) {
    // BB-128 phase 3b: a "Locate now" answer (saved or duplicate) closes that request.
    if (sample.source === "locate" && sample.requestId) markAnswered(sample.requestId, sample.timeLogId, recordedAt);
    const key = pairKey(sample.timeLogId, recordedAt);
    if (seen.has(key)) {
      results[index] = { status: "duplicate" };
      continue;
    }
    seen.add(key);
    results[index] = { status: "saved" };
    rows.push({
      id: crypto.randomUUID(),
      companyId: user.companyId,
      userId: user.id,
      timeLogId: sample.timeLogId,
      recordedAt,
      latitude: Number(sample.latitude),
      longitude: Number(sample.longitude),
      accuracy: optionalNumber(sample.accuracy),
      altitude: optionalNumber(sample.altitude),
      speed: optionalNumber(sample.speed),
      heading: optionalNumber(sample.heading),
      batteryLevel: cleanBatteryLevel(sample.batteryLevel),
      isMocked: sample.isMocked === true,
      source: cleanSource(sample.source),
    });
  }

  if (rows.length) {
    await prisma.locationBreadcrumb.createMany({ data: rows, skipDuplicates: true });
  }

  return { results };
}

module.exports = { saveBreadcrumbs };
