-- STR-051: the asset registry (Asset Management spec, decided 2026-07-20)
-- -- assets promoted to a first-class entity, existing before/without any
-- ownership. Purely additive (new table only) -- no
-- `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added.
--
-- `attributes` is stored as a JSON-serialized TEXT column, not JSONB --
-- no prior migration in this repo has needed a native JSON column, and
-- serializing/parsing at the aws-blocks/assets/assets-api.ts boundary keeps
-- this migration's behavior independent of any particular JSON driver
-- support.

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  type TEXT NOT NULL CHECK (type IN ('flat', 'plot', 'villa', 'dividend')),
  label TEXT,
  attributes TEXT,
  -- `allotted` is only ever set by ownership assignment (STR-053) -- never
  -- accepted on create/edit in this story.
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('allotted', 'available', 'society_retained')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
