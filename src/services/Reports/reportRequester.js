// src/services/Reports/reportRequester.js
//
// BB-119: who a report says requested it. Shared by every server-built report.
//   - A real user: their name and email.
//   - B. Buddy (BB-110): "B. Buddy (CODE)" — the support staff member's code
//     from the session (req.user.agentId → SupportAgent.code), never the
//     shared support email or any system ID. Just "B. Buddy" if the code
//     can't be read.

const { prisma } = require("@config/connection");

const personName = (u) => {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || null;
};

const fileSafe = (s) => String(s || "").replace(/[^a-z0-9-]+/gi, "_").replace(/^_+|_+$/g, "");

/**
 * @param {{ agentId?: string|null }} actor  req.user
 * @param {{ isSystemAgent?: boolean, email?: string, profile?: object }|null} me  the requester's User row
 * @returns {Promise<{ name: string, email: string|null, fileName: string }>}
 */
async function resolveRequester(actor, me) {
  if (me?.isSystemAgent) {
    const agent = actor?.agentId
      ? await prisma.supportAgent.findUnique({ where: { id: actor.agentId }, select: { code: true } }).catch(() => null)
      : null;
    const name = agent?.code ? `B. Buddy (${agent.code})` : "B. Buddy";
    return { name, email: null, fileName: fileSafe(agent?.code ? `B_Buddy_${agent.code}` : "B_Buddy") };
  }
  const name = personName(me) || "Unknown";
  return { name, email: me?.email || null, fileName: fileSafe(name) || "User" };
}

module.exports = { resolveRequester };
