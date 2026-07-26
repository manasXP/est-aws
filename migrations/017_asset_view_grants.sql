-- STR-057: per-project asset-view grants for employees (Asset Management
-- spec: "employees see nothing by default but can hold a per-project
-- asset-view grant"). A capability, not a role -- no new employees.capabilities
-- entry, since the grant is project-scoped rather than a flat boolean.
-- Purely additive (new tables only) -- no `-- contract-migration:`
-- annotation needed (see aws-blocks/migrations-lint.ts).
--
-- PUT /employees/{employeeId}/asset-view-grants replaces the whole set
-- (delete-then-reinsert, same "close everything, reopen the new set" shape
-- as migrations/012_project_committees.sql's seat replacement) -- no
-- surrogate id needed on the grants row itself.
CREATE TABLE asset_view_grants (
  employee_id TEXT NOT NULL REFERENCES employees (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  PRIMARY KEY (employee_id, project_id)
);

-- The audit trail for every PUT (Asset Management: "an audited admin
-- action" mirroring the designated verifier/finance-recorder pattern).
-- Nothing in this repo has needed a generic audit log before this story --
-- before/after are stored JSON-serialized as TEXT, the same convention
-- assets.attributes (migrations/007_assets.sql) established.
CREATE TABLE asset_view_grant_audits (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees (id),
  actor_member_id TEXT,
  actor_employee_id TEXT,
  before_project_ids TEXT NOT NULL,
  after_project_ids TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
