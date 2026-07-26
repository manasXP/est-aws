-- STR-071: the raw gapless per-FY receipt number allocator (Finance &
-- Compliance, receipts are "auto-numbered, gapless, per financial year").
-- Purely additive -- no `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts): CREATE TABLE matches none of its
-- destructive patterns.
--
-- One row per financial year, not a single global sequence: STR-073's
-- FY-boundary rollover needs each FY's series to start fresh at 1, which a
-- single shared counter could never do.
CREATE TABLE receipt_series_counters (
  fy_label TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1
);
