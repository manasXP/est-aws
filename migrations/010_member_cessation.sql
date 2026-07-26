-- STR-033: the cessation reason recorded by ceaseMember (members-api.ts),
-- required exactly when member_status is ceased (Domain Model, "ceased ...
-- cessation_reason required"). Purely additive (new column only) -- no
-- destructive DDL, so no `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).

ALTER TABLE members ADD COLUMN cessation_reason TEXT CHECK (cessation_reason IN ('resigned', 'expelled', 'deceased', 'transferred'));
