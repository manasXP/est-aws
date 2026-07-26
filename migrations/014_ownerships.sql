-- STR-053: ownerships reference registry assets directly by asset_id (Asset
-- Management spec, decided 2026-07-20) -- creating an ownership is the sole
-- writer of an asset's status/current_ownership_id, flipping an `available`
-- asset to `allotted` and pointing current_ownership_id at the new record,
-- atomically (aws-blocks/assets/ownerships-api.ts's createOwnership).
-- Purely additive (new table + new nullable column) -- no
-- `-- contract-migration:` annotation needed (see
-- aws-blocks/migrations-lint.ts).
--
-- Single society per deployment (CLAUDE.md, "Load-bearing rules"): no
-- society_id column, none should ever be added.
--
-- The UNIQUE constraint on asset_id currently means "at most one ownership
-- per asset, ever" -- correct today because there is no transfer/cessation
-- path yet. STR-055's close-and-create transfer will need multiple
-- ownership rows per asset over time (an owner history), so landing that
-- story will have to relax this to a partial unique index scoped to open
-- (not-yet-closed) ownerships -- the same pattern
-- migrations/003_reversal_uniqueness.sql used for reversals.
--
-- `co_owner_names` is stored JSON-serialized as TEXT, the same convention
-- assets.attributes (migrations/007_assets.sql) established -- no prior
-- migration in this repo uses a native JSON/JSONB column.
CREATE TABLE ownerships (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members (id),
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets (id),
  co_owner_names TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DEFERRABLE INITIALLY DEFERRED: the allotment transaction re-points this
-- column at an ownerships row created in the same transaction (see
-- createOwnership) -- the guarded UPDATE that sets it runs before the
-- corresponding INSERT into ownerships, so the FK target doesn't exist yet
-- until commit time. Never edited directly outside that transaction (or
-- STR-055's transfer, which will reuse the same guarded re-point).
ALTER TABLE assets ADD COLUMN current_ownership_id TEXT REFERENCES ownerships (id) DEFERRABLE INITIALLY DEFERRED;
