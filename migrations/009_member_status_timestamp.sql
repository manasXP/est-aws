-- STR-032 (code review follow-up): the story's Green plan calls for
-- recording "actor and timestamp" on suspend/reinstate, but only
-- status_actor was added (migrations/008_member_lifecycle.sql). This adds
-- the missing timestamp column. Purely additive -- no destructive DDL, so
-- no `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).

ALTER TABLE members ADD COLUMN status_changed_at TIMESTAMPTZ;
