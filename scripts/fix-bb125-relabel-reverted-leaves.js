// scripts/fix-bb125-relabel-reverted-leaves.js
//
// BB-125 — relabel past punch-vs-leave reverts from "cancelled" to "reverted".
//
// Before BB-125, when a conflict was resolved in favour of the punch (the
// "Automatically Resolve Punch-vs-Leave Conflicts" setting, or "Honor Punch")
// AND the old leave lookup happened to find the leave, the WHOLE leave was set
// to "cancelled" with approverComments
//   "Cancelled — conflict resolved in favour of punch during cutoff review"
// and its deduction refunded. Those were reverts, not employee cancellations.
//
// Plain run (default): READ-ONLY. Lists every such leave, all companies, with
// its dates, hours, refund and ledger, so it can be reviewed first.
//
// --apply (one transaction, only the listed leaves):
//   - Leave.status cancelled → reverted
//   - every LeaveDay of the leave: revertedAt = when it was cancelled (the
//     ledger "cancelled" row's time, else the leave's updatedAt), so readers
//     treat its days as reverted. revertedTimeLogId stays null (not recorded then).
//   - one "reverted" ledger row per leave: "Relabelled from cancelled (BB-125)"
// No balance or credit changes — the refund already happened at the time.
//
// --revert: undoes --apply from the backup (status back to cancelled, day
// stamps cleared, the added ledger rows deleted).
//
// RUN AFTER: scripts/bb125-leave-revert.sql + npx prisma generate.
// Backup: scripts/backup-bb125-relabel-reverted-leaves.json
//
// Usage:
//   node scripts/fix-bb125-relabel-reverted-leaves.js            # list only
//   node scripts/fix-bb125-relabel-reverted-leaves.js --apply
//   node scripts/fix-bb125-relabel-reverted-leaves.js --revert

try {
  require("dotenv").config();
} catch (_) {
  // dotenv optional — Prisma may already have loaded the env
}
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const MARKER = "conflict resolved in favour of punch";
const NOTE = "Relabelled from cancelled: punch honored over leave (BB-125)";
const BACKUP_FILE = path.join(__dirname, "backup-bb125-relabel-reverted-leaves.json");

const APPLY = process.argv.includes("--apply");
// Long enough for many round trips from a laptop to the Render database.
const TX_OPTIONS = { maxWait: 15000, timeout: 120000 };
const REVERT = process.argv.includes("--revert");

const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

async function loadCandidates() {
  const leaves = await prisma.leave.findMany({
    where: {
      status: "cancelled",
      approverComments: { contains: MARKER, mode: "insensitive" },
    },
    orderBy: { startDate: "asc" },
    select: {
      id: true, userId: true, leaveType: true, policyId: true, startDate: true, endDate: true,
      status: true, isPaid: true, actualPaidHours: true, actualUnpaidHours: true, approverComments: true, updatedAt: true,
      User: { select: { email: true, companyId: true, profile: { select: { firstName: true, lastName: true } } } },
      days: { select: { id: true, date: true, isPaid: true, hours: true, revertedAt: true } },
    },
  });
  const ids = leaves.map((l) => l.id);
  const ledger = ids.length
    ? await prisma.leaveTransaction.findMany({
        where:   { leaveId: { in: ids } },
        orderBy: { createdAt: "asc" },
        select:  { leaveId: true, type: true, hours: true, balanceBefore: true, balanceAfter: true, note: true, createdAt: true },
      })
    : [];
  const companyIds = [...new Set(leaves.map((l) => l.User?.companyId).filter(Boolean))];
  const companies = companyIds.length
    ? await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
    : [];
  const policyIds = [...new Set(leaves.map((l) => l.policyId || l.leaveType).filter(Boolean))];
  const policies = policyIds.length
    ? await prisma.leavePolicy.findMany({ where: { id: { in: policyIds } }, select: { id: true, leaveType: true } })
    : [];
  return {
    leaves,
    ledgerBy: (id) => ledger.filter((x) => x.leaveId === id),
    companyName: new Map(companies.map((c) => [c.id, c.name])),
    policyName: new Map(policies.map((p) => [p.id, p.leaveType])),
  };
}

function print({ leaves, ledgerBy, companyName, policyName }) {
  console.log(`Leaves cancelled by a punch-vs-leave conflict ("${MARKER}"): ${leaves.length}\n`);
  let lastCompany = null;
  for (const l of leaves) {
    const cid = l.User?.companyId;
    if (cid !== lastCompany) {
      console.log(`== ${companyName.get(cid) || cid}`);
      lastCompany = cid;
    }
    const name = [l.User?.profile?.firstName, l.User?.profile?.lastName].filter(Boolean).join(" ") || l.User?.email;
    const refund = ledgerBy(l.id).filter((x) => x.type === "adjustment").reduce((s, x) => s + Number(x.hours || 0), 0);
    console.log(`  ${l.id}  ${name}  ${policyName.get(l.policyId || l.leaveType) || "Leave"}  ${ymd(l.startDate)} → ${ymd(l.endDate)}  paid=${l.actualPaidHours} unpaid=${l.actualUnpaidHours}  days=${l.days.length}  refunded=${refund || "none recorded"}h`);
    for (const x of ledgerBy(l.id)) {
      console.log(`      ledger ${x.createdAt.toISOString()} ${x.type} hours=${x.hours} ${x.balanceBefore ?? ""}→${x.balanceAfter ?? ""} ${x.note ?? ""}`);
    }
  }
  console.log("");
}

async function apply(state) {
  if (fs.existsSync(BACKUP_FILE)) {
    console.log(`⛔ Backup already exists at ${BACKUP_FILE} — already applied? Nothing written.`);
    process.exitCode = 1;
    return;
  }
  const backup = { ticket: "BB-125", appliedAt: new Date().toISOString(), leaves: [] };

  await prisma.$transaction(async (tx) => {
    for (const l of state.leaves) {
      const cancelTxn = state.ledgerBy(l.id).filter((x) => x.type === "cancelled").pop();
      const when = cancelTxn?.createdAt ?? l.updatedAt;
      const claim = await tx.leave.updateMany({ where: { id: l.id, status: "cancelled" }, data: { status: "reverted" } });
      if (claim.count !== 1) throw new Error(`Leave ${l.id} is no longer cancelled — rolled back, nothing written`);
      const dayIds = l.days.filter((d) => !d.revertedAt).map((d) => d.id);
      if (dayIds.length) await tx.leaveDay.updateMany({ where: { id: { in: dayIds } }, data: { revertedAt: when } });
      const added = await tx.leaveTransaction.create({
        data: {
          userId: l.userId, type: "reverted", leaveId: l.id, performedById: null, note: NOTE,
          ...(await policyFor(tx, l)),
        },
      });
      backup.leaves.push({ leaveId: l.id, dayIds, ledgerId: added.id });
    }
  }, TX_OPTIONS);
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`✅ Relabelled ${backup.leaves.length} leave(s) to "reverted". Backup: ${BACKUP_FILE}`);
}

// The ledger row needs the leave's policy — take it from its deduction row, else the leave.
async function policyFor(tx, l) {
  const d = await tx.leaveTransaction.findFirst({ where: { leaveId: l.id, type: "deduction" }, select: { policyId: true } });
  return { policyId: d?.policyId ?? l.policyId ?? l.leaveType };
}

async function revert() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log(`No backup at ${BACKUP_FILE} — nothing to revert.`);
    return;
  }
  const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
  await prisma.$transaction(async (tx) => {
    for (const b of backup.leaves) {
      await tx.leave.updateMany({ where: { id: b.leaveId, status: "reverted" }, data: { status: "cancelled" } });
      if (b.dayIds.length) await tx.leaveDay.updateMany({ where: { id: { in: b.dayIds } }, data: { revertedAt: null } });
      await tx.leaveTransaction.deleteMany({ where: { id: b.ledgerId } });
    }
  }, TX_OPTIONS);
  fs.renameSync(BACKUP_FILE, BACKUP_FILE.replace(/\.json$/, `.reverted-${Date.now()}.json`));
  console.log(`↩️  Restored ${backup.leaves.length} leave(s) to "cancelled".`);
}

async function main() {
  if (REVERT) return revert();
  const state = await loadCandidates();
  print(state);
  if (!state.leaves.length) {
    console.log("Nothing to relabel.");
    return;
  }
  if (!APPLY) {
    console.log("List only — review it, then re-run with --apply to relabel these leaves.");
    return;
  }
  await apply(state);
}

main()
  .catch((e) => {
    console.error("❌", e.message?.includes("revertedAt") || e.message?.includes("reverted")
      ? `${e.message}\n   → Run scripts/bb125-leave-revert.sql and npx prisma generate first.`
      : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
