-- Migration: BB-112 — capacity history for the system-admin Performance page.
--
-- SAFE / ADDITIVE ONLY:
--   * creates ONE new table ("ServerMetricSample") and its index
--   * does not touch, alter, or delete anything in any existing table
--   * "IF NOT EXISTS" makes it safe to run twice
--   * runs in a transaction — if anything fails, nothing is applied
-- Nothing else references this table; dropping it later loses only the capacity history.
--
-- Run:   npx prisma db execute --file scripts/bb112-server-metric-samples.sql --schema src/prisma/schema.prisma
-- Then:  npx prisma generate, restart the server.

BEGIN;

CREATE TABLE IF NOT EXISTS "ServerMetricSample" (
  "id"               TEXT NOT NULL,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "instanceId"       TEXT,
  "uptimeSeconds"    INTEGER NOT NULL,
  "cpuPercent"       DOUBLE PRECISION,
  "rssMb"            DOUBLE PRECISION NOT NULL,
  "heapUsedMb"       DOUBLE PRECISION NOT NULL,
  "memoryLimitMb"    DOUBLE PRECISION,
  "eventLoopP99Ms"   DOUBLE PRECISION,
  "eventLoopMaxMs"   DOUBLE PRECISION,
  "inFlightPeak"     INTEGER NOT NULL,
  "requests"         INTEGER NOT NULL,
  "serverErrors"     INTEGER NOT NULL,
  "avgMs"            INTEGER,
  "p95Ms"            INTEGER,
  "dbLatencyMs"      INTEGER,
  "dbConnections"    INTEGER,
  "dbMaxConnections" INTEGER,
  "poolTimeouts"     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ServerMetricSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ServerMetricSample_createdAt_idx" ON "ServerMetricSample"("createdAt");

COMMIT;
