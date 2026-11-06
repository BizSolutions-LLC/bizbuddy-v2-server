// scripts/bb110-create-bbuddy-accounts.js
//
// BB-110 — creates the B. Buddy support account in existing companies.
// New companies get it automatically on signup / provisioning.
//
// Uses the same env the server does (never plain-text passwords):
//   BBUDDY_EMAIL          shared login email for every company
//   BBUDDY_PASSWORD_HASH  bcrypt hash of the shared password (make one with --hash)
//
// Each company gets one User row: role=admin, isSystemAgent=true,
// username "bbuddy-<companyId>", profile "B. Buddy", no department.
// Companies that already have B. Buddy are skipped. A company where a real user
// already uses BBUDDY_EMAIL is skipped and reported (email is unique per company).
//
// Run AFTER scripts/bb110-add-system-agent.sql + `npx prisma generate`.
//
// Usage:
//   node scripts/bb110-create-bbuddy-accounts.js --hash                    # prompts for a password, prints its bcrypt hash
//   node scripts/bb110-create-bbuddy-accounts.js --list                    # every company id/name + whether it has B. Buddy
//   node scripts/bb110-create-bbuddy-accounts.js --companyId=<id>          # dry run, one company (staged: Sunshine first)
//   node scripts/bb110-create-bbuddy-accounts.js --companyId=<id> --apply
//   node scripts/bb110-create-bbuddy-accounts.js --all                     # dry run, every company missing it
//   node scripts/bb110-create-bbuddy-accounts.js --all --apply
//
// Each --apply writes scripts/backup-bb110-bbuddy-created-<timestamp>.json
// with the created user ids.

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { buildSystemAgentData } = require("../src/services/systemAgentService");

const prisma = new PrismaClient();

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has("apply");
const COMPANY_ID = arg("companyId");
const ALL = has("all");

async function printHash() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await new Promise((resolve) => rl.question("B. Buddy password: ", resolve));
  rl.close();
  if (!password || password.length < 12) {
    console.log("Use at least 12 characters.");
    return;
  }
  console.log(`\nBBUDDY_PASSWORD_HASH=${bcrypt.hashSync(password, 10)}`);
  console.log("Put this in the server .env (and wherever you run this script), then restart the server.");
}

async function loadCompanies(where) {
  return prisma.company.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      User: { where: { isSystemAgent: true }, select: { id: true } },
    },
  });
}

async function list() {
  const companies = await loadCompanies({});
  console.log(`${companies.length} companies:\n`);
  for (const c of companies) {
    console.log(`  ${c.id}  ${c.User.length ? "[has B. Buddy]" : "[missing]    "}  ${c.name}`);
  }
}

async function create() {
  const email = (process.env.BBUDDY_EMAIL || "").trim().toLowerCase();
  const passwordHash = process.env.BBUDDY_PASSWORD_HASH || "";
  if (!email || !passwordHash.startsWith("$2")) {
    throw new Error("Set BBUDDY_EMAIL and BBUDDY_PASSWORD_HASH (a bcrypt hash — see --hash) first.");
  }

  const companies = await loadCompanies(COMPANY_ID ? { id: COMPANY_ID } : {});
  if (COMPANY_ID && !companies.length) throw new Error(`Company ${COMPANY_ID} not found.`);

  const toCreate = [];
  const skipped = [];
  for (const c of companies) {
    if (c.User.length) {
      skipped.push({ ...c, reason: "already has B. Buddy" });
      continue;
    }
    const clash = await prisma.user.findFirst({
      where: { companyId: c.id, email },
      select: { id: true },
    });
    if (clash) {
      skipped.push({ ...c, reason: `user ${clash.id} already uses ${email}` });
      continue;
    }
    toCreate.push(c);
  }

  console.log(`B. Buddy email: ${email}`);
  console.log(`To create (${toCreate.length}):`);
  toCreate.forEach((c) => console.log(`  + ${c.id}  ${c.name}`));
  if (skipped.length) {
    console.log(`Skipped (${skipped.length}):`);
    skipped.forEach((c) => console.log(`  - ${c.id}  ${c.name}  (${c.reason})`));
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }
  if (!toCreate.length) return;

  const created = [];
  for (const c of toCreate) {
    const user = await prisma.user.create({
      data: buildSystemAgentData(c.id, { email, passwordHash }),
      select: { id: true, username: true },
    });
    created.push({ companyId: c.id, companyName: c.name, userId: user.id, username: user.username });
    console.log(`  created ${user.id} for ${c.name}`);
  }

  const backupFile = path.join(
    __dirname,
    `backup-bb110-bbuddy-created-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(backupFile, JSON.stringify({ appliedAt: new Date().toISOString(), email, created }, null, 2));
  console.log(`\nCreated ${created.length}. Ids saved to ${backupFile}`);
}

async function main() {
  if (has("hash")) return printHash();
  if (has("list")) return list();
  if (!COMPANY_ID && !ALL) {
    console.log("Pass --list, --hash, --companyId=<id> or --all (see the header for usage).");
    return;
  }
  return create();
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
