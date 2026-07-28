-- STR-125: the informational work-order link on maintenance tickets
-- (Member Requests spec, Routing). The link is inert by design -- it never
-- participates in the ticket lifecycle, and the work-order -> invoice ->
-- approval money path is unchanged by ticketing.
--
-- The story anticipated E09's work_orders table possibly not existing yet
-- and allowed a plain identifier with a soft existence check; STR-081 has
-- since landed it (migrations/026), so this is a real FK from the start --
-- the "tighten later" follow-up the story named is unnecessary. The
-- category restriction (maintenance only) is enforced in
-- aws-blocks/tickets/work-order-link.ts, not by a CHECK: it is a rule about
-- who may write the column, not a shape the stored row must satisfy.
--
-- Purely additive (one nullable column) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).

ALTER TABLE tickets ADD COLUMN work_order_id TEXT REFERENCES work_orders (id);
