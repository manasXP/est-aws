-- STR-067: registered-devices store for the due-date reminder push dispatch
-- (aws-blocks/payments/reminders.ts), keyed off the run's own returned
-- Charge[] rather than a fresh query. Purely additive (new table only) --
-- no `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts): CREATE TABLE matches none of its
-- DESTRUCTIVE_PATTERNS.
--
-- Shape matches the Mobile Public API's device-registration contract
-- (est-spec/okf-bundle/api/mobile/openapi.yaml, POST /me/devices --
-- `platform: ios|android`, `push_token`) exactly, so that endpoint (ships
-- with the mobile milestone, E16/E17) is a straight INSERT against this
-- table with no schema changes of its own. This story ships no HTTP
-- endpoint against this table -- tests seed rows via direct SQL.
--
-- No UNIQUE constraint on push_token: "re-registering an existing token
-- updates it" (the OpenAPI's own wording) is that future endpoint's
-- upsert logic to implement, not this story's job to pre-empt.
CREATE TABLE registered_devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  push_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
