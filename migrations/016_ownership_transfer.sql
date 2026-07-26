-- STR-055: ownership transfer (close-and-create) and the minimal `charges`
-- shape its settlement gate reads. Purely additive/relaxing -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts):
-- `DROP CONSTRAINT` is not one of that script's destructive patterns (it only
-- flags `DROP TABLE`, `ALTER TABLE ... DROP COLUMN`, and `ALTER COLUMN ...
-- TYPE`), and nothing here drops a column or a table.
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added.
--
-- `closed_at IS NULL` means "currently open/active" -- once set, a row is
-- never unset or otherwise changed again (AC2, append-only history).
ALTER TABLE ownerships ADD COLUMN closed_at TIMESTAMPTZ;

-- migrations/014_ownerships.sql's plain UNIQUE(asset_id) meant "at most one
-- ownership per asset, ever" -- correct before transfer existed, but a
-- close-and-create transfer needs multiple ownership rows per asset over
-- time (an owner history), with at most one of them open at once. Relax to
-- a partial unique index scoped to open ownerships, the same pattern
-- migrations/003_reversal_uniqueness.sql used for reversals.
-- `ownerships_asset_id_key` is the actual constraint name Postgres assigned
-- for that UNIQUE(asset_id) column constraint (confirmed empirically against
-- this repo's local PGlite engine via information_schema.table_constraints,
-- not assumed from the default-naming convention).
ALTER TABLE ownerships DROP CONSTRAINT ownerships_asset_id_key;
CREATE UNIQUE INDEX ownerships_asset_id_open_idx ON ownerships (asset_id) WHERE closed_at IS NULL;

-- Minimal `charges` table, shaped to match STR-061's own story text ("member,
-- ownership/asset reference, kind (maintenance now; late_fee in STR-065),
-- period key, amount as NUMERIC, due date, status due|in_payment|paid") so
-- that story extends this table rather than recreating it. Referenced by
-- ownership_id (not asset_id): a transfer's new ownership row starts with
-- zero charge rows, which is what makes "charges accrue to the new owner
-- only" (AC4) fall out for free with no extra bookkeeping. `amount` is
-- NUMERIC(14,2), matching the money convention journal_lines.amount already
-- established (migrations/001_finance_journal.sql) -- money is always an
-- exact decimal string, never a float.
CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  ownership_id TEXT NOT NULL REFERENCES ownerships (id),
  kind TEXT NOT NULL DEFAULT 'maintenance',
  period_key TEXT,
  amount NUMERIC(14,2) NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'in_payment', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
