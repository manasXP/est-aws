-- STR-065 fix: 019_charges_idempotency.sql's (ownership_id, period_key,
-- kind) UNIQUE constraint applies to every `kind`, including `late_fee` --
-- but every `late_fee` charge raised by one `runLateFeeSweep` call shares
-- the same `period_key` (the sweep's own as-of period, not each source
-- charge's own period_key). So a single ownership with two simultaneous
-- overdue `maintenance` charges swept in one run produces two `late_fee`
-- inserts with the *same* (ownership_id, period_key, kind) tuple, which
-- collide on this constraint -- charges.ts's insertChargeIfAbsent uses a
-- bare `ON CONFLICT DO NOTHING` (no arbiter), which catches a violation of
-- *any* applicable unique constraint, so the second late fee is silently
-- dropped. `021_charges_late_fee.sql`'s own
-- charges_source_charge_period_unique partial index already correctly
-- dedups `late_fee` rows by source charge -- this constraint was only ever
-- meant to be the maintenance charge run's own dedup key (019's comment:
-- "the charge run's own dedup key"). Purely additive/relaxing -- no
-- `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts): DROP CONSTRAINT matches none of its
-- destructive patterns (DROP TABLE / DROP COLUMN / ALTER COLUMN ... TYPE).
ALTER TABLE charges DROP CONSTRAINT charges_ownership_period_kind_unique;
CREATE UNIQUE INDEX charges_ownership_period_kind_unique ON charges (ownership_id, period_key, kind) WHERE kind = 'maintenance';
