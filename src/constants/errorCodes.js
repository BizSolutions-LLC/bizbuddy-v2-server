// src/constants/errorCodes.js
//
// Central registry of application-level error codes, returned alongside
// `message` in error responses as `{ message, code }`. HTTP status still
// carries the primary meaning (409, 400, ...) — `code` lets client code
// branch on the *specific* reason without parsing message text.
//
// Human-readable strings, not opaque numbers — self-documenting, greppable,
// no lookup table needed. Not retrofitted across the whole app; seeded from
// the Leave module redo and meant to grow as new/touched error responses
// adopt this pattern. See docs/ERROR_CODES.md for the convention and the
// full registry table.

module.exports = {
  LEAVE_POLICY_IN_USE: "LEAVE_POLICY_IN_USE",
};
