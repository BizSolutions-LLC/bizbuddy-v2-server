-- ============================================================
-- Before recomputing leave cmr9gjn0h0nm0vh50jxu0w34z (Antonette Franco) to
-- exclude its two weekend days (Sat Jul 25 / Sun Jul 26, 2026): confirm
-- whether she has a REAL scheduled UserShift on those dates.
--
-- Per the confirmed BB-054 design, weekend-exclusion only ever applies to an
-- UNPLOTTED weekend day (priced via the flat company default). A weekend day
-- with an actual scheduled shift is always deductible regardless of the
-- toggle. 8h is ambiguous by itself — it's both a plausible real shift
-- length and this company's flat fallback default — so this has to be
-- checked against UserShift directly before any recompute is written.
-- Read-only.
-- ============================================================

SELECT
  u.email,
  us."assignedDate",
  us.status                                                        AS usershift_status,
  s."shiftName",
  s."startTime",
  s."endTime"
FROM "User" u
LEFT JOIN "UserShift" us ON us."userId" = u.id
                          AND us."assignedDate" IN ('2026-07-25', '2026-07-26')
LEFT JOIN "Shift" s      ON s.id = us."shiftId"
WHERE u.email = 'antoniaf@sbcglobal.net'
ORDER BY us."assignedDate";
