-- STR-045: the pool-user <-> actor link. A Cognito `sub` is a pool-user id;
-- aws-blocks/members/capabilities.ts resolves an Actor that is either a
-- member or an employee, so the correspondence has to live somewhere. It
-- lives on the record itself (the story's own Green step), not in a join
-- table -- an admin account is an attribute of the person, and the record is
-- what a provisioning run already has in hand.
--
-- Nullable: most members never get an admin-panel account (Governance &
-- Roles, "a designated subset get admin-panel accounts"), and a null subject
-- is exactly "no login". Unique per table so one pool user cannot be two
-- members; the cross-table case (a subject on both a member and an employee)
-- is not expressible as a constraint and is refused in
-- aws-blocks/http/capability-gate.ts instead.
--
-- Purely additive (two nullable columns) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).

ALTER TABLE members ADD COLUMN cognito_sub TEXT UNIQUE;
ALTER TABLE employees ADD COLUMN cognito_sub TEXT UNIQUE;
