-- STR-083: per-member invoice approvals, accumulated toward the majority
-- threshold recordApproval computes live (aws-blocks/vendors/
-- invoice-approvals.ts). Purely additive -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).
--
-- UNIQUE (invoice_id, member_id, is_override) is what makes recordApproval's
-- `ON CONFLICT DO NOTHING` insert idempotent (TC-VEN-023: a repeat approval
-- from the same member counts once) -- is_override is part of the key so a
-- member's normal-phase approval and a later EC-override approval (STR-084)
-- on the same invoice are distinct rows, not a conflict with each other.
CREATE TABLE invoice_approvals (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  member_id TEXT NOT NULL REFERENCES members (id),
  is_override BOOLEAN NOT NULL DEFAULT false,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  UNIQUE (invoice_id, member_id, is_override)
);
