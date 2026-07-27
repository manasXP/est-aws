-- STR-086: the payment record for an approved invoice (Vendor Workflow,
-- Finance & Compliance) -- one row per invoice, linking the posted journal
-- entry (aws-blocks/finance/journal.ts) to the method/amount/reference the
-- finance-recorder chose at payment time. Purely additive -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts).
--
-- UNIQUE (invoice_id): an invoice can only ever be paid once (recordInvoicePayment
-- flips invoices.status to 'paid' in the same guarded step, so this is a
-- backstop, not the primary guard).
CREATE TABLE invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices (id),
  method TEXT NOT NULL CHECK (method IN ('bank', 'cash')),
  amount NUMERIC(14,2) NOT NULL,
  paid_on DATE NOT NULL,
  reference TEXT,
  entry_id TEXT NOT NULL REFERENCES journal_entries (id),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
