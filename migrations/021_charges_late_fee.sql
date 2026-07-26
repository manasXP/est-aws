-- STR-065: late-fee charges from per-society rules. Purely additive -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts):
-- nothing here is a DROP TABLE / DROP COLUMN / ALTER COLUMN ... TYPE.
--
-- Late-fee formula (est-spec/okf-bundle/specifications/payments.md, "decided
-- 2026-07-26"): a flat amount per society, plus a per-society configurable
-- grace period in days past the original charge's due date. Both are left
-- NULL with no default -- unlike charge_settings.maintenance_fee's
-- 0.00-default-throws pattern (aws-blocks/payments/charges.ts,
-- ChargeSettingsNotConfiguredError), NULL here means "late fees are not
-- configured for this society", a legitimate steady state (AC2), not a
-- misconfiguration to reject.
ALTER TABLE charge_settings ADD COLUMN late_fee_amount NUMERIC(14,2);
ALTER TABLE charge_settings ADD COLUMN late_fee_grace_period_days INTEGER;

-- Traceability from a late_fee charge back to the overdue charge it was
-- raised from (AC1). Nullable -- only ever set on `late_fee` rows; every
-- pre-existing `maintenance` row (and any future non-late-fee kind) leaves
-- it NULL.
ALTER TABLE charges ADD COLUMN source_charge_id TEXT REFERENCES charges (id);

-- The real idempotency key for late fees: "at most one late-fee charge per
-- (overdue charge, period)" (story's T-P1/AC3). The (ownership_id,
-- period_key, kind) constraint from migrations/019_charges_idempotency.sql
-- is NOT sufficient here on its own -- a single ownership can have more than
-- one overdue source charge in flight at once (e.g. two unpaid months), and
-- that constraint would silently let only one of them get a late fee per
-- period, a real correctness bug. This partial unique index is additive and
-- independent, keyed on the source charge instead. Partial (WHERE
-- source_charge_id IS NOT NULL) so it says nothing about `maintenance` rows,
-- which always have a NULL source_charge_id.
CREATE UNIQUE INDEX charges_source_charge_period_unique ON charges (source_charge_id, period_key) WHERE source_charge_id IS NOT NULL;
