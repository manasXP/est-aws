-- STR-111: the document registry foundation (Document Management spec) --
-- one `documents` table serving society/project/member-level uploads, plus
-- the seeded `document_categories` list `category` validates against.
-- Purely additive (new tables only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).

CREATE TABLE document_categories (
  name TEXT PRIMARY KEY
);

INSERT INTO document_categories (name) VALUES
  ('Bye-laws'),
  ('Registration Certificate'),
  ('AGM/EC Meeting Minutes'),
  ('Audit Reports'),
  ('Insurance Policies'),
  ('Statutory Filings'),
  ('Circulars'),
  ('Sanctioned Plans'),
  ('Completion/Occupancy Certificates'),
  ('NOCs'),
  ('Vendor Contracts'),
  ('Share Certificate'),
  ('Sale/Transfer Deeds'),
  ('KYC'),
  ('Nomination Forms'),
  ('Correspondence');

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('society', 'project', 'member')),
  project_id TEXT REFERENCES projects (id),
  member_id TEXT REFERENCES members (id),
  title TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES document_categories (name),
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  member_visible BOOLEAN NOT NULL DEFAULT false,
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial immutability trigger (mirrors migrations/002_journal_immutability.sql's
-- shape): the file-identity columns are frozen once written -- checksum and
-- size_bytes are still written lazily on first read (STR-111's
-- register-then-verify design), and status/title/category/tags/notes/
-- member_visible remain updatable for later stories (archive/restore,
-- metadata edits, the member_visible flag).
CREATE FUNCTION forbid_document_identity_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.file_key IS DISTINCT FROM OLD.file_key
    OR NEW.file_name IS DISTINCT FROM OLD.file_name
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.level IS DISTINCT FROM OLD.level
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
    OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
  THEN
    RAISE EXCEPTION 'documents: file_key, file_name, mime_type, level, project_id, member_id, uploaded_by, and uploaded_at are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_identity_immutable
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION forbid_document_identity_mutation();
