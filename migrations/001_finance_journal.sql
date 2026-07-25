-- STR-021: finance journal foundation. Purely additive (new tables only) --
-- no destructive DDL, so no `-- contract-migration:` annotation is needed
-- (see aws-blocks/migrations-lint.ts).
--
-- Append-only by domain rule (migrations/REVIEW-CHECKLIST.md, "Ledger
-- append-only rule"): this migration creates the tables but grants no
-- UPDATE/DELETE path anywhere in this diff. Corrections are reversing
-- entries (a later story), never edits.

-- AC4: bank accounts and cash are ledger accounts; postings reference
-- ledger accounts only.
CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  -- Exact decimal, never a float (Finance & Compliance, "Decisions 2026-07-20").
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0)
);

-- Seed exactly the accounts this story requires. Member/vendor account
-- seeding is out of scope here (later stories).
INSERT INTO ledger_accounts (id, name, kind) VALUES
  ('cash', 'Cash', 'cash'),
  ('bank', 'Bank', 'bank');
