-- STR-094: signed idempotent webhook settlement (aws-blocks/payments/
-- webhook-settlement.ts). Purely additive -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): neither statement
-- below matches its destructive patterns.
--
-- `webhook_events` is the idempotency ledger for inbound provider webhook
-- deliveries -- `provider_event_id` is UNIQUE so an `INSERT ... ON CONFLICT
-- (provider_event_id) DO NOTHING` (the same insert-if-absent idiom
-- aws-blocks/payments/charges.ts's insertChargeIfAbsent already uses) tells
-- a duplicate delivery from a genuinely new one via `rowCount`.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL UNIQUE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `failure_reason` records a failure webhook's reported reason; unset on any
-- other status. `flagged_for_reconciliation` is set when a success webhook's
-- reported amount doesn't match the intent's own total -- the gateway
-- payment likely did happen, just for the wrong total, so this is left for
-- STR-096 or a human to resolve rather than silently marked paid or reverted
-- to `due` (no partial payments in v1).
ALTER TABLE payment_intents ADD COLUMN failure_reason TEXT, ADD COLUMN flagged_for_reconciliation BOOLEAN NOT NULL DEFAULT false;

-- Mirrors migrations/011_employees.sql's 'expense' ledger account seed --
-- the credit side of a settled member payment (STR-023's Payment Ledger
-- projection, `counterparty_type = 'member'`).
INSERT INTO ledger_accounts (id, name, kind) VALUES ('member_dues', 'Member Dues', 'income');
