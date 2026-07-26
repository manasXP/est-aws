-- STR-044: designated-approver EC subset configuration -- the admin-panel
-- config table naming which EC members are in the designated subset for
-- invoice approval (Governance & Roles: "approval requires a majority of
-- the designated EC subset", configurable per society, not hardcoded).
-- Purely additive (new table only) -- no destructive DDL, so no
-- `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).
--
-- The other two governance capabilities (designated-verifier, finance-
-- recorder) already have a configuration home: employees.capabilities
-- (migrations/011_employees.sql), plus finance-recorder's default grant to
-- the current Treasurer, read directly off role_assignments -- no new table
-- needed for either.

CREATE TABLE capability_approver_designations (
  member_id TEXT PRIMARY KEY REFERENCES members(id)
);
