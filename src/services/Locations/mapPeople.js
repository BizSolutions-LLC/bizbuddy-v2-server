// src/services/Locations/mapPeople.js
//
// BB-128 map views (2026-11-25): how a person is drawn on the Employee Map.
// Every view (Clock-in/out, Routes, Live) labels a pin with the employee's
// initials and a colour. The colour comes from the user id, so one person has
// the same colour on every tab, on every load, on web and mobile.

// 12 colours that read on the OpenStreetMap tiles and carry white initials.
const PALETTE = [
  "#2563EB", "#DC2626", "#059669", "#7C3AED", "#D97706", "#DB2777",
  "#0891B2", "#65A30D", "#9333EA", "#EA580C", "#0D9488", "#4F46E5",
];

function personName(u) {
  const name = `${u?.profile?.firstName || ""} ${u?.profile?.lastName || ""}`.trim();
  return name || u?.email || "Unknown";
}

/** "Carlo Corcuera" → "CC"; one name → its first two letters; email → first letter. */
function initialsOf(u) {
  const first = String(u?.profile?.firstName || "").trim();
  const last = String(u?.profile?.lastName || "").trim();
  if (first && last) return (first[0] + last[0]).toUpperCase();
  const single = first || last;
  if (single) return single.slice(0, 2).toUpperCase();
  return String(u?.email || "?").charAt(0).toUpperCase();
}

/** Stable colour from the user id (FNV-1a hash → palette). */
function colorOf(userId) {
  let h = 0x811c9dc5;
  for (const ch of String(userId || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** { initials, color } for a user row that has id, email, profile. */
const markerOf = (u) => ({ initials: initialsOf(u), color: colorOf(u?.id) });

module.exports = { personName, initialsOf, colorOf, markerOf, PALETTE };
