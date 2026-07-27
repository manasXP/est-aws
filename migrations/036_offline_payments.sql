-- STR-095: offline (cash/cheque) payment records against a charge
-- (aws-blocks/payments/offline-payments.ts) -- the offline mirror of
-- STR-094's gateway settlement path, same accounting shape, only the debited
-- account differs. Purely additive -- no `-- contract-migration:` annotation
-- needed (see aws-blocks/migrations-lint.ts): CREATE TABLE matches none of
-- its destructive patterns.
--
-- UNIQUE (charge_id, idempotency_key) is what makes a replayed
-- `Idempotency-Key` a no-op returning the original result rather than a
-- second posting: recordOfflinePayment looks the row up by this pair before
-- doing anything else, and the constraint backstops a concurrent duplicate.
--
-- `method` mirrors the Admin OpenAPI's own enum ('cash' | 'cheque') -- note
-- these are the *collection* methods, not the ledger accounts they debit
-- ('cash' -> the Cash Book's `cash` account, 'cheque' -> the Bank Book's
-- `bank` account, since a cheque clears through the society's bank account
-- and never as cash-in-hand). invoice_payments.method (migrations/
-- 033_invoice_payments.sql) is the other spelling -- there the vendor-side
-- API names the account directly ('bank' | 'cash').
--
-- `recorded_by` holds the acting actor's id with no FK: finance-recorder
-- defaults to the current Treasurer (a member) but is delegable to an
-- employee, so the id can point at either registry -- exactly the same
-- reasoning and shape as invoice_payments.recorded_by.
CREATE TABLE offline_payments (
  id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL REFERENCES charges (id),
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'cheque')),
  amount NUMERIC(14,2) NOT NULL,
  received_on DATE NOT NULL,
  reference TEXT,
  entry_id TEXT NOT NULL REFERENCES journal_entries (id),
  recorded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (charge_id, idempotency_key)
);
