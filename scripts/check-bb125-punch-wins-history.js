// scripts/check-bb125-punch-wins-history.js
//
// BB-125 — READ-ONLY audit of every past "punch wins over leave" resolution,
// all companies. Node wrapper around scripts/check-bb125-punch-wins-history.sql
// (the queries live there — one source of truth). Runs them inside a READ ONLY
// transaction that is always rolled back: it cannot change anything.
//
// Sections (see the .sql header for details):
//   1. Punches resolved "punch takes precedence"   → flag DA_SHORTENED
//   2. Days of leaves reverted by punch-wins        → flag REVERTED_NO_PUNCH
//   3. Leaves still approved on a punched day       → flag AUTO_REVERT_FAILED / APPROVED_OVER_LEAVE
//   4. Summary per company
//
// Prints the flagged rows per section (plus the summary) and writes every row to
//   scripts/check-bb125-punch-wins-history.output.json
//
// Usage:
//   node scripts/check-bb125-punch-wins-history.js          # flagged rows only
//   node scripts/check-bb125-punch-wins-history.js --all    # every row

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SQL_FILE = path.join(__dirname, "check-bb125-punch-wins-history.sql");
const OUT_FILE = path.join(__dirname, "check-bb125-punch-wins-history.output.json");
const SHOW_ALL = process.argv.includes("--all");

const SECTIONS = [
  { title: "1. Punches resolved \"punch takes precedence\"", flagged: (r) => r.flag === "DA_SHORTENED" || r.flag === "DA_CHECK",
    cols: ["company", "employee", "punch_date", "punch_type", "resolved_by", "raw_punch", "current_punch", "raw_hours", "current_hours", "segments", "cutoff_status", "flag"] },
  { title: "2. Days of leaves reverted/cancelled by punch-wins", flagged: (r) => r.flag === "REVERTED_NO_PUNCH",
    cols: ["company", "employee", "leave_type", "leave_status", "day", "dow", "leave_day_hours", "leave_day_paid", "punches", "approval_statuses", "flag"] },
  { title: "3. Leaves STILL approved on a day with an approved punch", flagged: () => true,
    cols: ["company", "employee", "leave_type", "day", "leave_hours", "leave_paid", "punch", "punch_type", "approved_automatically", "cutoff_status", "flag"] },
  { title: "4. Summary per company", flagged: () => true,
    cols: ["company", "punches_honored", "da_punches_honored", "da_shortened", "punches_excluded_for_leave"] },
];

// Plain JSON values: BigInt → number, Decimal → number, Date → YYYY-MM-DD / ISO.
function clean(v) {
  if (v == null) return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof v === "object" && typeof v.toNumber === "function") return v.toNumber();
  return v;
}

function loadStatements() {
  const sql = fs.readFileSync(SQL_FILE, "utf8")
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))      // drop comment lines (they contain ';')
    .join("\n");
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|ROLLBACK)\b/i.test(s));
}

class Rollback extends Error {}

async function main() {
  const statements = loadStatements();
  if (statements.length !== SECTIONS.length) {
    throw new Error(`Expected ${SECTIONS.length} queries in ${SQL_FILE}, found ${statements.length}`);
  }

  let results = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      for (const stmt of statements) {
        const rows = await tx.$queryRawUnsafe(stmt);
        results.push(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clean(v)]))));
      }
      throw new Rollback(); // never commit — read-only either way
    }, { maxWait: 15000, timeout: 300000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(
    Object.fromEntries(SECTIONS.map((s, i) => [s.title, results[i]])), null, 2
  ));

  SECTIONS.forEach((s, i) => {
    const rows = results[i];
    const shown = SHOW_ALL ? rows : rows.filter(s.flagged);
    console.log(`\n=== ${s.title} — ${rows.length} row(s)${SHOW_ALL ? "" : `, ${shown.length} flagged`} ===`);
    if (!shown.length) {
      console.log("  (none)");
      return;
    }
    console.table(shown.map((r) => Object.fromEntries(s.cols.map((c) => [c, r[c]]))));
  });

  console.log(`\nAll rows (with ids and emails) saved to ${OUT_FILE}`);
}

main()
  .catch((e) => {
    console.error("❌", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
