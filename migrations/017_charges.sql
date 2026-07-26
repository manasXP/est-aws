-- STR-061: the charges table backing the scheduled maintenance charge run
-- (aws-blocks/payments/charges.ts). Purely additive (new tables only) -- no
-- `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added -- charge_settings is a
-- singleton row (`id` is always the literal 'default'), not a per-society
-- config table, matching that same invariant.
--
-- Deliberately no uniqueness constraint across (ownership_id, period_key,
-- kind): idempotent re-run dedup is STR-063's job, not this story's --
-- adding it now would either block a future STR-063 migration from
-- introducing it cleanly or force this story to guess at STR-063's exact
-- shape. `kind` allows 'late_fee' for the same reason -- the enum value is
-- reserved for STR-065, which writes it; this story only ever writes
-- 'maintenance'.
CREATE TABLE charge_settings (
  id TEXT PRIMARY KEY,
  maintenance_fee NUMERIC(14,2) NOT NULL
);

INSERT INTO charge_settings (id, maintenance_fee) VALUES ('default', 0.00);

CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  ownership_id TEXT NOT NULL REFERENCES ownerships (id),
  asset_id TEXT NOT NULL REFERENCES assets (id),
  kind TEXT NOT NULL CHECK (kind IN ('maintenance', 'late_fee')),
  period_key TEXT NOT NULL,
  -- Exact decimal, never a float (Finance & Compliance, "Decisions 2026-07-20").
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'in_payment', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
