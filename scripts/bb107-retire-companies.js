// scripts/bb107-retire-companies.js
//
// BB-107 — retires an old company: its people can no longer sign in or receive
// anything, its data stays, and it gets its new name. One company per run.
//
// For the company given with --companyId (must be in RETIRE below):
//   1. every user (B. Buddy included) → status "inactive" (users already
//      inactive or deleted keep their status)
//   2. every user is signed out everywhere (tokenVersion + 1) and their phone
//      push token is cleared
//   3. the company's notification switches are turned off
//   4. the company is renamed
// Time logs, payroll, leave, cutoffs and every other record are not touched.
//
// The dry run also lists people whose email is active in another company —
// they stay active there (this works per company, not per email).
//
// Usage:
//   node scripts/bb107-retire-companies.js --list                          # the plan + where each company stands
//   node scripts/bb107-retire-companies.js --companyId=<id>                # dry run
//   node scripts/bb107-retire-companies.js --companyId=<id> --apply
//   node scripts/bb107-retire-companies.js --restore=<backup file> [--apply]  # undo: old name, switches, statuses, push tokens
//
// Each --apply first writes scripts/backup-bb107-retire-<companyId>-<timestamp>.json.
// A restore can't bring old sessions back — people sign in again.

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Confirmed 2026-10-28. Matched by id, never by name. `from` lists every name the
// company may have now — the first retire run used AAA–EEE; the final names are
// ZZZ–VVV so retired companies sort to the bottom of every list. Re-running on an
// already-retired company only renames it (everyone is already inactive).
const RETIRE = {
  cmn8p2jex000hrfwrtecwfaxy: { from: ["BizMobile Development Inc.", "AAA Company"], to: "ZZZ Company" },
  cm8381j48001avrj4u93nlyu9: { from: ["BizSolutions LLC", "BBB Company"], to: "YYY Company" },
  cmf8uzyih0010pz4zrvx4fx5v: { from: ["Comfort Homes", "CCC Company"], to: "XXX Company" },
  cmg097m73000brfgwvdv1yuwy: { from: ["Nikey", "DDD Company"], to: "WWW Company" },
  cmaeu57rk0003vry4f7z6waw6: { from: ["Team Geo", "EEE Company"], to: "VVV Company" },
};

const NOTIFY_FLAGS = ["notifyEmployeeMissedIn", "notifyEmployeeMissedOut", "notifyAdminMissedClocks"];

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has("apply");

const fullName = (u) =>
  [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(" ") || "(no name)";

async function list() {
  console.log("Retire plan:\n");
  for (const [id, plan] of Object.entries(RETIRE)) {
    const c = await prisma.company.findUnique({ where: { id }, select: { name: true } });
    const active = c ? await prisma.user.count({ where: { companyId: id, status: "active" } }) : 0;
    const state = !c ? "NOT FOUND" : c.name === plan.to ? "retired" : `${active} active users`;
    console.log(`  ${id}  ${(c?.name || plan.from[0]).padEnd(28)} → ${plan.to.padEnd(12)}  [${state}]`);
  }
}

async function retire(companyId) {
  const plan = RETIRE[companyId];
  if (!plan) throw new Error(`${companyId} isn't in the retire plan. Run --list.`);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, ...Object.fromEntries(NOTIFY_FLAGS.map((f) => [f, true])) },
  });
  if (!company) throw new Error(`Company ${companyId} not found.`);
  if (!plan.from.includes(company.name) && company.name !== plan.to)
    throw new Error(`Company ${companyId} is named "${company.name}", expected one of: ${plan.from.join(", ")}. Stopping.`);

  const clash = await prisma.company.findFirst({ where: { name: plan.to, NOT: { id: companyId } }, select: { id: true } });
  if (clash) throw new Error(`Another company (${clash.id}) is already named "${plan.to}".`);

  const users = await prisma.user.findMany({
    where: { companyId },
    orderBy: { email: "asc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      isSystemAgent: true,
      tokenVersion: true,
      deviceToken: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  });

  const emails = [...new Set(users.map((u) => u.email).filter(Boolean))];
  const elsewhere = await prisma.user.findMany({
    where: { email: { in: emails }, status: "active", NOT: { companyId } },
    select: { email: true, company: { select: { name: true } } },
  });
  const supportStaff = await prisma.supportAgent.findMany({
    where: { companyId, archivedAt: null },
    select: { code: true, name: true },
  });

  const toDeactivate = users.filter((u) => u.status === "active");
  console.log(`${company.name} (${companyId}) → "${plan.to}"\n`);
  console.log(`Users: ${users.length} total, ${toDeactivate.length} active → inactive. All are signed out; push tokens cleared.`);
  for (const u of users) {
    const tag = u.isSystemAgent ? " [B. Buddy]" : "";
    const change = u.status === "active" ? "active → inactive" : `stays ${u.status}`;
    console.log(`  ${String(u.email || "").padEnd(40)} ${fullName(u).padEnd(28)} ${String(u.role).padEnd(11)} ${change}${tag}`);
  }
  console.log(`\nNotification switches: ${NOTIFY_FLAGS.map((f) => `${f}=${company[f]}`).join(", ")} → all false`);

  if (elsewhere.length) {
    console.log(`\nAlso active in another company (they stay active there):`);
    for (const e of elsewhere) console.log(`  ${e.email}  — ${e.company?.name}`);
  }
  if (supportStaff.length) {
    console.log(`\nSupport staff assigned here (re-assign them in the dashboard): ${supportStaff.map((s) => `${s.code} ${s.name}`).join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  const backupFile = path.join(
    __dirname,
    `backup-bb107-retire-${companyId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(
    backupFile,
    JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        company: { id: companyId, name: company.name, ...Object.fromEntries(NOTIFY_FLAGS.map((f) => [f, company[f]])) },
        users: users.map((u) => ({ id: u.id, email: u.email, status: u.status, deviceToken: u.deviceToken })),
      },
      null,
      2
    )
  );
  console.log(`\nBackup written: ${backupFile}`);

  await prisma.$transaction([
    prisma.user.updateMany({
      where: { companyId, status: "active" },
      data: { status: "inactive" },
    }),
    prisma.user.updateMany({
      where: { companyId },
      data: { tokenVersion: { increment: 1 }, deviceToken: null },
    }),
    prisma.company.update({
      where: { id: companyId },
      data: { name: plan.to, ...Object.fromEntries(NOTIFY_FLAGS.map((f) => [f, false])) },
    }),
  ]);

  console.log(`Done: ${toDeactivate.length} deactivated, ${users.length} signed out, renamed to "${plan.to}".`);
}

async function restore(file) {
  const backup = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const { company, users } = backup;
  console.log(`Restore ${company.id}: name → "${company.name}", switches → as before, ${users.length} users → previous status and push token.`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  const { id, name, ...flags } = company;
  await prisma.$transaction([
    prisma.company.update({ where: { id }, data: { name, ...flags } }),
    ...users.map((u) =>
      prisma.user.update({ where: { id: u.id }, data: { status: u.status, deviceToken: u.deviceToken } })
    ),
  ]);
  console.log("Restored. People sign in again (old sessions stay ended).");
}

async function main() {
  if (has("list")) return list();
  if (arg("restore")) return restore(arg("restore"));
  const companyId = arg("companyId");
  if (!companyId) {
    console.log("Pass --list, --companyId=<id> or --restore=<file> (see the header for usage).");
    return;
  }
  return retire(companyId);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
