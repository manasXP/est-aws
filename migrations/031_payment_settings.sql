-- STR-093: convenience fee itemization (aws-blocks/payments/
-- convenience-fee.ts). Purely additive -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): neither statement
-- below matches its destructive patterns.
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added -- payment_settings is a
-- singleton row (`id` is always the literal 'default'), matching
-- charge_settings's (migrations/018_charges.sql) and society_settings's
-- (migrations/024_society_settings.sql) precedent. Kept as its own table,
-- separate from society_settings, since that table belongs to E08 and this
-- story has no reason to couple to it.
CREATE TABLE payment_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  convenience_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  absorb_fees BOOLEAN NOT NULL DEFAULT false
);

-- Seeded at migration time, same "singleton always exists" precedent as
-- charge_settings/society_settings -- the real per-society rate/toggle is
-- set later by a direct SQL UPDATE, no HTTP endpoint (this story's own
-- stated scope).
INSERT INTO payment_settings (id) VALUES ('default');

-- STR-093: itemization/audit columns on the existing payment_intents table
-- (migrations/029_payment_intents.sql). `amount` (unchanged) becomes the
-- fee-inclusive checkout total the provider is charged; these two columns
-- record the itemization for storage/audit/reconciliation even though the
-- Mobile OpenAPI's PaymentIntent/Payment schemas surface no separate fee
-- field.
ALTER TABLE payment_intents ADD COLUMN payment_method TEXT, ADD COLUMN convenience_fee NUMERIC(14,2) NOT NULL DEFAULT 0;
