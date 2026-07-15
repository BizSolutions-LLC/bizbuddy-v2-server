// server.js
// Node 22+ removed SlowBuffer; legacy jwa/buffer-equal-constant-time still expects it.
const buffer = require("buffer");
if (!buffer.SlowBuffer) {
  buffer.SlowBuffer = buffer.Buffer;
}

require("module-alias/register");
// Must load before app.js / @routes/index.js — it patches Express's router
// methods so every async route handler registered afterwards automatically
// forwards rejections to errorHandler.js instead of crashing the process on
// an unhandled rejection. See docs/CLAUDE.md "Key Conventions" for why this
// exists — a real production incident (deletePolicy FK violation) took the
// whole server down before this was added.
require("express-async-errors");

const dotenv = require("dotenv");
dotenv.config();

const app = require("./app.js");
const { connect } = require("@config/connection");
const router = require("@routes/index.js");
const { errorLogger } = require("@middlewares/requestLogger");
const errorHandler = require("@middlewares/errorHandler");
const logger = require("@config/logger");
const http = require("http");

// Defense-in-depth for async errors OUTSIDE the Express request cycle —
// cron jobs and workers (leaveAccrualWorker, checkMissedClockIns, etc.)
// aren't covered by express-async-errors since they never go through a
// route. Log and keep the process alive instead of crashing on these too.
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err}`);
});

const PORT = process.env.PORT || 5000;
const ENV  = process.env.NODE_ENV || "development";

app.use("/api", router);
app.use(errorLogger);
app.use(errorHandler);

const server = http.createServer(app);

// ── Boot sequence ─────────────────────────────────────────────────────────────

connect()
  .then(() => {
    // Services
    const { init: initSocket }          = require("@config/socket");
    const { initFirebase, isFirebaseReady } = require("@config/firebase");
    const { scheduleLeaveAccrual }      = require("@workers/leaveAccrualWorker");
    const { scheduleClockOutReminders } = require("@workers/clockOutReminderWorker");
    const { scheduleClockInReminders }  = require("@workers/clockInReminderWorker");
    const { initializeCronJobs }        = require("@utils/cronScheduler");

    initSocket(server);
    initFirebase();
    scheduleLeaveAccrual();
    scheduleClockOutReminders();
    scheduleClockInReminders();
    initializeCronJobs();

    server.listen(PORT, () => {
      const firebaseOk = isFirebaseReady();
      const notifEmail = process.env.NOTIFICATION_SMTP_USER || "—";
      const clientUrl  = process.env.CLIENT_URL             || "—";
      const line       = "─".repeat(54);

      console.log(`\n┌${line}┐`);
      console.log(`│  BizBuddy API Server                                 │`);
      console.log(`└${line}┘`);
      console.log(`  env        ${ENV}`);
      console.log(`  port       ${PORT}`);
      console.log(`  client     ${clientUrl}`);
      console.log(`  db         connected`);
      console.log(``);
      console.log(`  services`);
      console.log(`  ✓  Socket.io`);
      console.log(`  ${firebaseOk ? "✓" : "✗"}  Firebase push${firebaseOk ? "" : "  (disabled — check env vars)"}`);
      console.log(`  ✓  Email  ${notifEmail}`);
      console.log(``);
      console.log(`  cron jobs`);
      console.log(`  ✓  Auto clock-out              every 5 min`);
      console.log(`  ✓  Missed clock-in check       every 5 min`);
      console.log(`  ✓  Missed clock-out check      every 5 min`);
      console.log(`  ✓  Clock-in reminders          30 min before shift`);
      console.log(`  ✓  Clock-out reminders         30 min before shift end`);
      console.log(`  ✓  Leave accrual               daily`);
      console.log(`  ✓  Morning reports             10:00 AM daily`);
      console.log(`  ✓  Evening reports             6:00 PM daily`);
      console.log(`\n  started    ${new Date().toISOString()}`);
      console.log(`└${line}┘\n`);
    });
  })
  .catch((error) => {
    console.error("❌ Unable to connect to the database:", error);
    process.exit(1);
  });
