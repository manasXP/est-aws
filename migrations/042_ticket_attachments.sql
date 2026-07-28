-- STR-124: ticket-scoped attachments. The Member Requests spec is explicit
-- that these are NOT registry documents: "the document registry stays a
-- management-curated corpus with mandatory category metadata; member-
-- uploaded ticket photos carry none of that." So this table has no link to
-- `documents` and no category column -- the separation is a permanent
-- design decision, not a temporary gap (contrast STR-025, which used a
-- direct object path only because the registry did not exist yet).
--
-- Purely additive (new table only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): CREATE TABLE
-- matches none of its DESTRUCTIVE_PATTERNS.
--
-- `object_path` is the FileBucket key, always under a `tickets/<ticketId>/`
-- prefix so bucket contents are partitioned by ticket and can never
-- collide with the registry's own `documents/` prefix. The bucket itself
-- is shared (estatly-documents) -- adding a second FileBucket would mean a
-- new stateful Block ID, and those are immutable once deployed.
CREATE TABLE ticket_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  object_path TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ticket_attachments_ticket_id_idx ON ticket_attachments (ticket_id, uploaded_at);
