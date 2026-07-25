-- STR-025: ledger-entry document links. Purely additive (new table only) --
-- no destructive DDL, so no `-- contract-migration:` annotation is needed
-- (see aws-blocks/migrations-lint.ts).
--
-- The full document registry (title/category/metadata) is E12 (M3) and does
-- not exist yet, so a "document" here is addressed directly by its
-- FileBucket object path — there is no documents table to reference. E12
-- will mint real registry document_ids later; until then this link table's
-- `document_path` is the only identity a document has.
--
-- Append-only like the journal itself (Finance & Compliance, "documents are
-- immutable once attached"): no update/delete path anywhere in this diff,
-- enforced with the same trigger pattern migrations/002 used for
-- journal_entries/journal_lines (the local PGlite connection runs as the
-- database owner, which REVOKE would not actually restrict).

CREATE TABLE journal_entry_documents (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  document_path TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, document_path)
);

CREATE FUNCTION forbid_document_link_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'journal_entry_documents is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entry_documents_immutable
  BEFORE UPDATE OR DELETE ON journal_entry_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_document_link_mutation();
