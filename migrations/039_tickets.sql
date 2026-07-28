-- STR-121: the member-request foundation (Member Requests spec) -- the
-- tickets table every other E13 story reads or mutates, plus the
-- per-category default-assignee routing configuration ("designated is
-- configurable, not hardcoded", Governance & Roles). No society_id on
-- either table -- single society per deployment. Purely additive (new
-- tables only) -- no `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts).

CREATE TABLE ticket_routing (
  category TEXT PRIMARY KEY CHECK (category IN ('finance', 'maintenance', 'records', 'general')),
  assignee_id TEXT NOT NULL REFERENCES employees (id)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  category TEXT NOT NULL CHECK (category IN ('finance', 'maintenance', 'records', 'general')),
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'withdrawn')),
  assignee_id TEXT REFERENCES employees (id),
  -- STR-125's on-behalf entry records the acting admin here; always NULL
  -- on the member-created path (STR-121 T-U4).
  entered_by TEXT REFERENCES employees (id),
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);
