-- STR-022: journal immutability + reversing-entry linking. Purely additive
-- (new nullable column, new trigger function, new triggers) — nothing is
-- dropped or type-changed, so no `-- contract-migration:` annotation is
-- needed (see aws-blocks/migrations-lint.ts).
--
-- Ledger append-only rule (migrations/REVIEW-CHECKLIST.md, "Ledger
-- append-only rule"; Finance & Compliance, "Ledger entries are append-only
-- with an audit trail; corrections are reversing entries, not edits."):
-- corrections happen via a linked reversing entry (STR-022's reversal
-- service), never via UPDATE/DELETE. The guard below is enforced with
-- triggers rather than REVOKE — the local PGlite connection runs as the
-- database owner, which REVOKE would not actually restrict, but a trigger
-- fires for every role including the owner.

-- Links a reversal entry back to the entry it corrects (STR-022, T-U2).
ALTER TABLE journal_entries ADD COLUMN reverses_entry_id TEXT REFERENCES journal_entries(id);

CREATE FUNCTION forbid_journal_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'journal_entries and journal_lines are append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();
