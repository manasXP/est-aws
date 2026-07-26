-- STR-073: FY-boundary rollover of the receipt series. `society_settings`
-- holds the receipt prefix `formatReceiptNumber` (aws-blocks/finance/
-- receipts.ts) reads to build `<prefix>/<fy-label>/<counter>`. Purely
-- additive -- no `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts): CREATE TABLE matches none of its
-- destructive patterns.
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added -- a singleton row (`id` is
-- always the literal 'default'), matching charge_settings's precedent
-- (migrations/018_charges.sql), not a per-society config table.
CREATE TABLE society_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  receipt_prefix TEXT NOT NULL
);

-- Empty-string seed, same "not yet configured" spirit as charge_settings'
-- `0.00` maintenance_fee default -- the real per-society prefix (e.g. 'SOC')
-- is set later by a direct SQL UPDATE, no HTTP endpoint (per this story's
-- own stated scope).
INSERT INTO society_settings (id, receipt_prefix) VALUES ('default', '');
