-- STR-115: Postgres FTS over document metadata (Document Management spec:
-- "full-text over title, category, tags, notes, and file_name... content
-- search (OCR) is deferred past v1"), plus the member_visible before/after
-- columns STR-115 adds to STR-112's audit trail. First tsvector use in this
-- codebase. Purely additive (new columns + function + index) -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts).

-- array_to_string() is only STABLE, which a GENERATED column rejects; for
-- text[] it is immutable in practice, so this thin wrapper asserts that.
CREATE FUNCTION documents_tags_text(tags TEXT[]) RETURNS TEXT
  IMMUTABLE
  LANGUAGE sql
  AS $$ SELECT array_to_string(tags, ' ') $$;

-- file_name is de-punctuated before indexing: the default parser lexes
-- 'gymnasium-invoice.pdf' as a single `file` token, which a word query
-- like 'gymnasium' would never match.
ALTER TABLE documents ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english',
    title || ' ' ||
    category || ' ' ||
    documents_tags_text(tags) || ' ' ||
    coalesce(notes, '') || ' ' ||
    translate(file_name, '-_./', '    ')
  )) STORED;

CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector);

-- The audit rows written before this migration predate the flag being
-- editable, so both columns stay nullable; every row written from STR-115
-- on carries both values.
ALTER TABLE document_metadata_audits
  ADD COLUMN before_member_visible BOOLEAN,
  ADD COLUMN after_member_visible BOOLEAN;
