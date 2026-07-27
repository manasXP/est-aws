-- STR-081: E09's genesis migration -- vendors, work orders, and the
-- append-only work order event log (aws-blocks/vendors/work-orders.ts).
-- Purely additive (new tables only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column on any of these tables.
CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vendor Workflow spec's decided state machine: issued -> in_progress ->
-- completed | cancelled. `completed` is reserved in the CHECK constraint but
-- has no writer yet -- this story's own scope stops at issued/in_progress/
-- cancelled (see aws-blocks/vendors/work-orders.ts's module comment).
CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors (id),
  scope TEXT NOT NULL,
  value NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'in_progress', 'completed', 'cancelled')),
  issued_on DATE NOT NULL,
  valid_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail of every work order lifecycle action -- no
-- update/delete path anywhere touches this table (Definition of Done),
-- matching the journal_entries precedent (migrations/002_journal_immutability.sql).
CREATE TABLE work_order_events (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders (id),
  action TEXT NOT NULL CHECK (action IN ('issued', 'amended', 'cancelled')),
  actor_id TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Minimal shell only -- STR-082 extends this additively with the rest of the
-- invoice fields. Exists here purely so amendWorkOrder's amendment gate can
-- check "has any invoice ever been submitted against this work order"
-- (Vendor Workflow spec's decided amendment rule).
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders (id),
  status TEXT NOT NULL DEFAULT 'submitted'
);
