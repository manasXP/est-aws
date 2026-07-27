-- STR-092: payment initiation with idempotent charge locking
-- (aws-blocks/payments/payment-initiation.ts). Purely additive (new table
-- only) -- no `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added.
--
-- `provider_params` is stored JSON-serialized as TEXT, not a native JSONB
-- column -- the same convention assets.attributes (migrations/007_assets.sql)
-- and ownerships.co_owner_names (migrations/014_ownerships.sql) established:
-- no prior migration in this repo uses a native JSON/JSONB column.
--
-- The UNIQUE (member_id, idempotency_key) constraint is the DB-level backstop
-- for concurrent identical-key retries -- the application-level pre-check in
-- initiatePayment can race against it, so this constraint (not just the
-- pre-check) is what actually guarantees at most one row per key.
CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members (id),
  charge_ids TEXT[] NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'pending', 'succeeded', 'failed')),
  provider TEXT NOT NULL,
  provider_intent_id TEXT NOT NULL,
  provider_params TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, idempotency_key)
);
