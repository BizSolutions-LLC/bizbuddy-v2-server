// src/utils/csv.js
//
// BB-119: clean CSV for server-built report exports — one header row, then data.
// Starts with a UTF-8 byte-order mark so Excel reads names with accents
// correctly, and uses CRLF line endings. Text that would run as a formula is
// neutralised (see neutralise below).

// CSV injection guard: a text cell starting with = + - @ (or tab / CR) is run as a
// formula when the file is opened in Excel or Sheets. Prefix it with ' so it shows
// as plain text. Real numbers (and number-like text such as "-1.50") are left alone.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER_LIKE = /^[+-]?\d+(\.\d+)?$/;
const neutralise = (s) => (FORMULA_START.test(s) && !NUMBER_LIKE.test(s) ? `'${s}` : s);

const cell = (v) => {
  if (v == null) return "";
  const s = typeof v === "string" ? neutralise(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * @param {string[]} headers
 * @param {Array<Array<any>>} rows
 * @returns {Buffer}
 */
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(cell).join(","));
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

module.exports = { toCsv };
