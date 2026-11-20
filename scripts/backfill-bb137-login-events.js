// scripts/backfill-bb137-login-events.js
//
// BB-137: rebuild past login history (LoginEvent) from RequestLog, which has
// every sign-in / sign-out request: time, IP, user agent, status code, and the
// body with email, companyId and deviceId (password already hidden).
//
// - Only RequestLog rows BEFORE the first live LoginEvent are imported, so live
//   and imported history never overlap.
// - Imported in time order, so the flags (platform switch, new device, shared
//   device, failed-attempt burst) are worked out like the live ones.
// - Safe to re-run: each RequestLog row is imported once (LoginEvent.requestLogId
//   is unique); already-imported rows are skipped.
// - Reads RequestLog in small batches by the (endpoint, createdAt) index. Run it
//   OFF-HOURS: the database is small.
//
// What history can't tell (no response body was logged): a 403 on sign-in could
// be "inactive" or a device conflict, so it's imported as "denied".
//
// DRY RUN by default (counts only, no writes). Pass --apply to write.
// Options: --since YYYY-MM-DD (only from that date), --batch N (default 500).
//
// Order: scripts/add-login-events-bb137.sql → prisma generate → deploy → this.
// Usage: node scripts/backfill-bb137-login-events.js
//        node scripts/backfill-bb137-login-events.js --apply

require("module-alias/register");
const { prisma } = require("@config/connection");
const { writeLoginEvent, platformOf, outcomeFromStatus, cleanBrowserId } = require("@services/Security/loginEventService");
const { getNormalizedDeviceId } = require("@utils/mobileDeviceLogin");

const APPLY = process.argv.includes("--apply");
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const BATCH = Math.min(Math.max(parseInt(arg("--batch"), 10) || 500, 50), 2000);
const SINCE = arg("--since") ? new Date(`${arg("--since")}T00:00:00.000Z`) : null;

const SIGN_IN = ["/api/account/login", "/api/account/sign-in"];
const SIGN_OUT = ["/api/account/sign-out"];

const asObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

async function main() {
  const firstLive = await prisma.loginEvent.findFirst({
    where: { source: "live" },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const before = firstLive?.createdAt || new Date();
  console.log(`\nBB-137 login history backfill — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  console.log(`Importing RequestLog sign-in/sign-out requests before ${before.toISOString()}${SINCE ? ` and from ${SINCE.toISOString()}` : ""}.`);

  const where = {
    endpoint: { in: [...SIGN_IN, ...SIGN_OUT] },
    createdAt: { lt: before, ...(SINCE && { gte: SINCE }) },
  };
  const total = await prisma.requestLog.count({ where });
  console.log(`Found ${total} request(s).\n`);
  if (!total) return;

  const userCache = new Map(); // `${email}|${companyId}` → user | null
  const findUser = async (email, companyId) => {
    if (!email || !companyId) return null;
    const k = `${email}|${companyId}`;
    if (!userCache.has(k)) {
      userCache.set(k, await prisma.user.findFirst({
        where: { email, companyId: String(companyId) },
        select: { id: true, companyId: true, isSystemAgent: true, status: true },
      }));
    }
    return userCache.get(k);
  };

  const stats = { seen: 0, imported: 0, skipped: 0, failed: 0, byOutcome: {}, byPlatform: {}, first: null, last: null };
  let cursor = null;

  for (;;) {
    const rows = await prisma.requestLog.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BATCH,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      select: {
        id: true, method: true, endpoint: true, statusCode: true, requestBody: true, queryParams: true,
        userId: true, companyId: true, ipAddress: true, userAgent: true, createdAt: true, isSystemAgent: true,
      },
    });
    if (!rows.length) break;

    for (const r of rows) {
      stats.seen += 1;
      stats.first = stats.first || r.createdAt;
      stats.last = r.createdAt;
      const body = { ...asObject(r.queryParams), ...asObject(r.requestBody) };
      const isSignOut = SIGN_OUT.includes(r.endpoint);
      if (isSignOut && (r.statusCode >= 400 || !r.userId)) { stats.skipped += 1; continue; }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : null;
      const user = isSignOut ? null : await findUser(email, body.companyId);
      const deviceId = (user?.isSystemAgent ? null : getNormalizedDeviceId(body.deviceId)) || null;
      const browserId = cleanBrowserId(body.browserId);
      let outcome = isSignOut ? "success" : outcomeFromStatus(r.statusCode);
      if (!isSignOut && r.statusCode === 403 && user && user.status === "active") outcome = "denied";
      const platform = platformOf({ deviceId, browserId, userAgent: r.userAgent });

      stats.byOutcome[outcome] = (stats.byOutcome[outcome] || 0) + 1;
      stats.byPlatform[platform] = (stats.byPlatform[platform] || 0) + 1;
      if (!APPLY) continue;

      try {
        await writeLoginEvent({
          companyId: isSignOut ? r.companyId : user?.companyId || (body.companyId ? String(body.companyId).slice(0, 64) : null),
          userId: isSignOut ? r.userId : user?.id || null,
          email: isSignOut ? null : email,
          event: isSignOut ? "sign_out" : "sign_in",
          outcome,
          platform,
          deviceId: deviceId ? String(deviceId).slice(0, 200) : null,
          browserId,
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
          isSystemAgent: Boolean(user?.isSystemAgent || r.isSystemAgent),
          source: "backfill",
          requestLogId: r.id,
          createdAt: r.createdAt,
        });
        stats.imported += 1;
      } catch (e) {
        if (e?.code === "P2002") stats.skipped += 1; // already imported
        else {
          stats.failed += 1;
          if (stats.failed <= 5) console.error(`  ! ${r.id}: ${e.message}`);
        }
      }
    }

    cursor = rows[rows.length - 1].id;
    process.stdout.write(`  … ${stats.seen}/${total}\r`);
  }

  console.log(`\n\nRequests read: ${stats.seen} (${stats.first?.toISOString() ?? "-"} → ${stats.last?.toISOString() ?? "-"})`);
  console.log("By outcome:", stats.byOutcome);
  console.log("By platform:", stats.byPlatform);
  if (APPLY) console.log(`Imported: ${stats.imported}, skipped (already imported / failed sign-outs): ${stats.skipped}, errors: ${stats.failed}`);
  else console.log(`Would import about ${stats.seen - stats.skipped} event(s). Run again with --apply to write them.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
