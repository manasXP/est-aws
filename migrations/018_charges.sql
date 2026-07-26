-- STR-061: the scheduled maintenance charge run (aws-blocks/payments/
-- charges.ts). Purely additive/relaxing -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): neither ADD
-- CONSTRAINT statement below matches its destructive patterns (DROP TABLE /
-- DROP COLUMN / ALTER COLUMN ... TYPE).
--
-- `charges` already exists as of migrations/016_ownership_transfer.sql
-- (STR-055, merged first) -- that migration's own comment explicitly
-- anticipated this: "the minimal shape STR-061 will extend, not recreate."
-- This migration ALTERs it rather than CREATE-ing a second table, and does
-- NOT add an `asset_id` column: this story's own code (aws-blocks/payments/
-- charges.ts) already has the asset id in hand from listBillableOwnerships
-- when it builds a Charge, so a denormalized stored column would be pure
-- duplication, not a read need. STR-055's aws-blocks/assets/
-- ownership-settlement.ts already reads `ownership_id`/`status` from this
-- table unchanged -- neither column is touched here.
--
-- `period_key` is left nullable at the DB level, even though this story's
-- own writer always supplies one: STR-055's own test fixture
-- (test/assets/ownerships-api.test.ts, seedCharge) already inserts a row
-- with no period_key, predating this migration -- a `SET NOT NULL` here
-- would break already-merged, already-reviewed code for a constraint this
-- story's application layer already guarantees on its own write path.
ALTER TABLE charges ADD CONSTRAINT charges_amount_positive CHECK (amount > 0);
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('maintenance', 'late_fee'));

-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added -- charge_settings is a
-- singleton row (`id` is always the literal 'default'), not a per-society
-- config table, matching that same invariant.
--
-- Deliberately no uniqueness constraint across (ownership_id, period_key,
-- kind) on `charges`: idempotent re-run dedup is STR-063's job, not this
-- story's -- adding it now would either block a future STR-063 migration
-- from introducing it cleanly or force this story to guess at STR-063's
-- exact shape. `kind` allows 'late_fee' for the same reason -- the enum
-- value is reserved for STR-065, which writes it; this story only ever
-- writes 'maintenance'.
CREATE TABLE charge_settings (
  id TEXT PRIMARY KEY,
  maintenance_fee NUMERIC(14,2) NOT NULL
);

INSERT INTO charge_settings (id, maintenance_fee) VALUES ('default', 0.00);
