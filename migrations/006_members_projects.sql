-- STR-031: the members and projects registries (Domain Model, "Member
-- attributes (from the brief)" / Projects belong to the Society). Purely
-- additive (new tables only) -- no destructive DDL, so no
-- `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): neither
-- table carries a society_id column, and none should ever be added.

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  -- Set only by the (not yet built) lifecycle transition function on
  -- admission (STR-032) -- new members are pending with joining_date null;
  -- PATCH /v1/members/{memberId} must never write either column (Domain
  -- Model, "Member status lifecycle", decided 2026-07-20).
  joining_date DATE,
  member_status TEXT NOT NULL DEFAULT 'pending' CHECK (member_status IN ('pending', 'active', 'suspended', 'ceased'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);
