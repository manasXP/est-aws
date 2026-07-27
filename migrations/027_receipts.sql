-- STR-079: persisted receipt records, assembling STR-071/073/075/077's
-- outputs plus the STR-025 document link into one row per issued receipt.
-- Purely additive -- no `-- contract-migration:` annotation needed.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  fy_label TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  amount TEXT NOT NULL,
  gstin TEXT,
  taxable_amount TEXT,
  cgst_amount TEXT,
  sgst_amount TEXT,
  treasurer_name TEXT,
  document_path TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
