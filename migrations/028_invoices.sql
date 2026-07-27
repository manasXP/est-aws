-- STR-082: extends STR-081's minimal invoices shell (migrations/026) with
-- the real invoice fields, and adds the append-only invoice_events audit
-- trail mirroring work_order_events. Purely additive -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts).
--
-- vendor_id/amount/invoice_date/document_id are NOT NULL: vendor_id is
-- always stamped from the work order (aws-blocks/vendors/invoices.ts's
-- submitInvoice), and amount/invoice_date/document_id are required at the
-- API layer (Admin OpenAPI's createInvoice requestBody). Safe to add as
-- NOT NULL with no default -- the invoices table is unreleased and always
-- empty at this point in a fresh migration run.
ALTER TABLE invoices
  ADD COLUMN vendor_id TEXT NOT NULL REFERENCES vendors (id),
  ADD COLUMN amount NUMERIC(14,2) NOT NULL,
  ADD COLUMN gst_amount NUMERIC(14,2),
  ADD COLUMN invoice_number TEXT,
  ADD COLUMN invoice_date DATE NOT NULL,
  ADD COLUMN document_id TEXT NOT NULL,
  ADD COLUMN resubmission_of TEXT REFERENCES invoices (id),
  ADD COLUMN resubmitted_as TEXT,
  ADD COLUMN notes TEXT;

-- status can also hold verified/approved/rejected/paid -- STR-083/084 write
-- those; this story only ever writes 'submitted', but T-U3 seeds a
-- 'rejected' row directly and AC2 talks about non-rejected states.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check CHECK (status IN ('submitted', 'verified', 'approved', 'rejected', 'paid'));

CREATE TABLE invoice_events (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  action TEXT NOT NULL CHECK (action IN ('submitted', 'verified', 'approved', 'rejected', 'paid')),
  actor_id TEXT,
  actor_type TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);
