-- STR-043: Project committee (PC) appointment and composition, on the
-- STR-041 tenure-history pattern (migrations/011_role_assignments.sql in
-- that story's worktree -- not yet merged, so this replicates the pattern
-- into its own tables rather than depending on it). Purely additive (new
-- tables only) -- no destructive DDL, so no `-- contract-migration:`
-- annotation is needed (see aws-blocks/migrations-lint.ts).

-- One PC per project (AC2): project_id UNIQUE is the literal invariant.
CREATE TABLE project_committees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  -- Set on every setProjectCommittee write (aws-blocks/projects/
  -- committees-api.ts) -- the ProjectCommittee schema's `updated_at`.
  updated_at TIMESTAMPTZ
);

CREATE TABLE project_committee_seats (
  id TEXT PRIMARY KEY,
  committee_id TEXT NOT NULL REFERENCES project_committees(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  is_chair BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE NOT NULL,
  effective_to DATE
);

-- Append-only tenure history (AC3), same shape as migrations/
-- 011_role_assignments.sql's trigger: a row may be updated exactly once, to
-- close it (set effective_to from NULL to a date) -- never re-opened, never
-- have any other column changed, never deleted.
CREATE OR REPLACE FUNCTION enforce_project_committee_seat_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_committee_seats rows are append-only: delete is not permitted';
  END IF;
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'project_committee_seats rows are append-only: row % is already closed', OLD.id;
  END IF;
  IF NEW.effective_to IS NULL THEN
    RAISE EXCEPTION 'project_committee_seats rows are append-only: an update must close the seat (set effective_to)';
  END IF;
  IF NEW.id <> OLD.id OR NEW.committee_id <> OLD.committee_id OR NEW.member_id <> OLD.member_id OR NEW.is_chair <> OLD.is_chair OR NEW.effective_from <> OLD.effective_from THEN
    RAISE EXCEPTION 'project_committee_seats rows are append-only: only effective_to may change when closing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_committee_seats_append_only
BEFORE UPDATE OR DELETE ON project_committee_seats
FOR EACH ROW EXECUTE FUNCTION enforce_project_committee_seat_append_only();

-- Concurrency backstop (same shape as role_assignments_open_unique): a
-- member can't hold two simultaneously-open seats on the same committee.
CREATE UNIQUE INDEX project_committee_seats_open_unique ON project_committee_seats (committee_id, member_id) WHERE effective_to IS NULL;
