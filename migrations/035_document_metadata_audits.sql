-- STR-112: the audit trail for document metadata edits (Document Management
-- spec: metadata "stays editable by management, with changes audit-trailed").
-- One row per successful PATCH, mirroring migrations/017_asset_view_grants.sql's
-- asset_view_grant_audits shape -- actor from resolveActor, before/after
-- values with `tags` JSON-serialized as TEXT (the same convention
-- asset_view_grant_audits and assets.attributes already established).
-- Purely additive (new table only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).
CREATE TABLE document_metadata_audits (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id),
  actor_member_id TEXT,
  actor_employee_id TEXT,
  before_title TEXT NOT NULL,
  after_title TEXT NOT NULL,
  before_category TEXT NOT NULL,
  after_category TEXT NOT NULL,
  before_tags TEXT NOT NULL,
  after_tags TEXT NOT NULL,
  before_notes TEXT,
  after_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
