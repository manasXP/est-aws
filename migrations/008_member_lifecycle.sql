-- STR-032: the member lifecycle transition function (members-api.ts's
-- transitionMemberStatus, the only writer of member_status) records who
-- performed a suspend/reinstate. Purely additive (new column only) -- no
-- destructive DDL, so no `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).

ALTER TABLE members ADD COLUMN status_actor TEXT;
