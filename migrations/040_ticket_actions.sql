-- STR-122: the append-only ticket status-history trail behind the admin
-- OpenAPI's `TicketDetail.actions` (STR-126 surfaces it). Every successful
-- lifecycle transition in aws-blocks/tickets/lifecycle.ts appends exactly
-- one row in the same transaction as the tickets UPDATE, so a rejected
-- transition leaves no trace. Tickets are never deleted and this trail is
-- never mutated -- it is the audit record the Member Requests spec calls
-- for ("the thread and status history are the audit trail").
--
-- Purely additive (new table only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts): CREATE TABLE
-- matches none of its DESTRUCTIVE_PATTERNS.
--
-- `actor_id` is TEXT with no FK: it holds a member id (reopen, withdraw),
-- an employee id (assign, resolve), or the literal 'system' for the
-- auto-close CronJob -- three different identity spaces, so no single
-- REFERENCES target exists.
--
-- `notes` carries the resolution note on the `resolved` row; NULL on every
-- other action.
CREATE TABLE ticket_actions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  action TEXT NOT NULL CHECK (action IN ('opened', 'assigned', 'resolved', 'reopened', 'withdrawn', 'closed')),
  actor_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE INDEX ticket_actions_ticket_id_idx ON ticket_actions (ticket_id, at);
