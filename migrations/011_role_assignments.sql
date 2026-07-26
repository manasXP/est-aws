-- STR-041: Management/EC role assignments with tenure history (Governance &
-- Roles: elections happen offline; the system records assignments as admin
-- actions with effective from/to dates). Purely additive (new table only) --
-- no destructive DDL, so no `-- contract-migration:` annotation is needed
-- (see aws-blocks/migrations-lint.ts).

CREATE TABLE role_assignments (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  role TEXT NOT NULL CHECK (role IN ('management', 'president', 'vice_president', 'general_secretary', 'treasurer', 'executive_member')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  acting_admin TEXT
);

-- Append-only tenure history (T-P1): a row may be updated exactly once, to
-- close it (set effective_to from NULL to a date) — never re-opened, never
-- have any other column changed, never deleted. Mirrors migrations/002's
-- immutability-trigger pattern.
CREATE OR REPLACE FUNCTION enforce_role_assignment_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'role_assignments rows are append-only: delete is not permitted';
  END IF;
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'role_assignments rows are append-only: row % is already closed', OLD.id;
  END IF;
  IF NEW.effective_to IS NULL THEN
    RAISE EXCEPTION 'role_assignments rows are append-only: an update must close the assignment (set effective_to)';
  END IF;
  IF NEW.id <> OLD.id OR NEW.member_id <> OLD.member_id OR NEW.role <> OLD.role OR NEW.effective_from <> OLD.effective_from THEN
    RAISE EXCEPTION 'role_assignments rows are append-only: only effective_to may change when closing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_assignments_append_only
BEFORE UPDATE OR DELETE ON role_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_role_assignment_append_only();

-- Concurrency backstop (same shape as migrations/003's partial unique index
-- for reversals): at most one open assignment per (member, role) at a time.
CREATE UNIQUE INDEX role_assignments_open_unique ON role_assignments (member_id, role) WHERE effective_to IS NULL;
