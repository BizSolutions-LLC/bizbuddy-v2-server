// scripts/bb110-create-system-admin.js
//
// BB-110 — creates a system-admin account (individual login + 2FA).
// Use it once to create the first Owner; after that, owners add the other
// admins from the system-admin dashboard (POST /api/system-admin/admins).
//
// The new admin sets up their authenticator app on first sign-in.
//
// Run AFTER scripts/bb110-system-admins.sql + `npx prisma generate`.
//
// Usage:
//   node scripts/bb110-create-system-admin.js --owner     # prompts for username, name, password
//   node scripts/bb110-create-system-admin.js             # non-owner admin
//   node scripts/bb110-create-system-admin.js --list      # shows existing admins
//   node scripts/bb110-create-system-admin.js --reset-2fa=<username>
//        emergency: clears 2FA + lockout and ends sessions (lost phone AND recovery
//        codes, with no other owner to reset it from the dashboard)

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const readline = require("readline");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const OWNER = process.argv.includes("--owner");
const LIST = process.argv.includes("--list");
const RESET_2FA = (process.argv.find((a) => a.startsWith("--reset-2fa=")) || "").slice("--reset-2fa=".length);

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Don't echo the password as it's typed
      rl._writeToOutput = (str) => {
        if (str.includes(question)) rl.output.write(str);
        else rl.output.write("*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function list() {
  const admins = await prisma.systemAdmin.findMany({ orderBy: { createdAt: "asc" } });
  if (!admins.length) return console.log("No system admins yet.");
  for (const a of admins) {
    console.log(
      `  ${a.username.padEnd(20)} ${a.name.padEnd(24)} ${a.isOwner ? "owner" : "admin"}  ` +
        `${a.active ? "active" : "inactive"}  2FA: ${a.totpEnabledAt ? "on" : "not set up"}`
    );
  }
}

async function create() {
  const username = (await ask("Username (e.g. carlo): ")).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error("Username: 3–40 letters, digits, dots, dashes or underscores.");
  if (await prisma.systemAdmin.findUnique({ where: { username } })) throw new Error(`Username ${username} already exists.`);

  const name = await ask("Full name: ");
  if (!name) throw new Error("Name is required.");

  const password = await ask("Password (min 12 characters): ", { hidden: true });
  if (password.length < 12) throw new Error("Password must be at least 12 characters.");
  const confirm = await ask("Confirm password: ", { hidden: true });
  if (password !== confirm) throw new Error("Passwords don't match.");

  const admin = await prisma.systemAdmin.create({
    data: { username, name, passwordHash: bcrypt.hashSync(password, 10), isOwner: OWNER },
  });
  console.log(`\nCreated ${OWNER ? "owner" : "admin"} ${admin.username} (${admin.id}).`);
  console.log("Sign in on the system-admin dashboard — you'll be asked to set up your authenticator app.");
}

async function reset2fa() {
  const admin = await prisma.systemAdmin.findUnique({ where: { username: RESET_2FA.toLowerCase() } });
  if (!admin) throw new Error(`No system admin named ${RESET_2FA}.`);
  await prisma.systemAdmin.update({
    where: { id: admin.id },
    data: {
      totpSecret: null,
      totpPendingSecret: null,
      totpEnabledAt: null,
      lastTotpStep: null,
      recoveryCodes: [],
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
  console.log(`2FA cleared for ${admin.username}. They'll set up a new authenticator at next sign-in.`);
}

(LIST ? list() : RESET_2FA ? reset2fa() : create())
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
