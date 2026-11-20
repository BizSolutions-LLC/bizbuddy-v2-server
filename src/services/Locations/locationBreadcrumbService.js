const crypto = require("crypto");
const { prisma } = require("@config/connection");
const { checkBatchShape, classifySample, cleanSource } = require("./locationBreadcrumbRules");

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
  const results = [];

  for (const sample of shaped.samples) {
    const decision = classifySample(sample, byId.get(sample && sample.timeLogId), now);
    if (decision.status !== "ok") {
      results.push({ status: "rejected", reason: decision.reason });
      continue;
    }
    try {
      await prisma.locationBreadcrumb.create({
        data: {
          id: crypto.randomUUID(),
          companyId: user.companyId,
          userId: user.id,
          timeLogId: sample.timeLogId,
          recordedAt: decision.recordedAt,
          latitude: Number(sample.latitude),
          longitude: Number(sample.longitude),
          accuracy: optionalNumber(sample.accuracy),
          altitude: optionalNumber(sample.altitude),
          speed: optionalNumber(sample.speed),
          heading: optionalNumber(sample.heading),
          isMocked: sample.isMocked === true,
          source: cleanSource(sample.source),
        },
      });
      results.push({ status: "saved" });
    } catch (err) {
      if (err && err.code === "P2002") {
        results.push({ status: "duplicate" });
        continue;
      }
      throw err;
    }
  }

  return { results };
}

module.exports = { saveBreadcrumbs };
