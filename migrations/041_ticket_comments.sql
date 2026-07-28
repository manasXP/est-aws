-- STR-123: the ticket comment thread -- the append-only conversation
-- between the member and staff that the Member Requests spec calls part of
-- the audit trail ("tickets are never deleted; the thread and status
-- history are the audit trail"). One shared table behind both surfaces'
-- comment endpoints, so the OpenAPI's single TicketComment schema has a
-- single source regardless of which side wrote the row.
--
-- Purely additive (new table only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): CREATE TABLE
-- matches none of its DESTRUCTIVE_PATTERNS.
--
-- `author_id` is TEXT with no FK for the same reason as ticket_actions.
-- actor_id (migrations/040): it holds a member id when author_kind is
-- 'member' and an employee id when it is 'staff' -- two identity spaces,
-- no single REFERENCES target.
--
-- `author_name` is denormalised deliberately: the thread is an audit
-- record, so it must keep the name as it stood when the comment was
-- posted, not follow a later rename of the member or employee.
-- `seq` is the ordering key, not `created_at`: AC1 requires the thread to
-- preserve *posting* order, and two comments posted inside the same clock
-- tick would tie on a timestamp (and then fall back to a random UUID).
-- A sequence is monotonic by construction, so the read order is the write
-- order regardless of clock resolution.
CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'staff')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ticket_comments_ticket_id_idx ON ticket_comments (ticket_id, seq);
