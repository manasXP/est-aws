// STR-055: the "collectibility predicate" the story's own Refactor section
// names -- transferOwnership's settlement gate (TC-AST-020), factored into
// its own file so it's independently reusable rather than inlined into
// ownerships-api.ts. E04's cessation flow (STR-033) reads outstanding
// charges too (its own ownership-lookup guard), so this is meant to be the
// one predicate both eventually consume -- not wired into STR-033's
// already-shipped code by this story (out of scope, see final report).
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';

/**
 * True iff the ownership carries no outstanding (non-`paid`) charge row.
 * The `charges` table (migrations/016_ownership_transfer.sql) is the
 * minimal shape STR-061 will extend, not recreate.
 */
export async function isOwnershipSettled(db: Database, ownershipId: string): Promise<boolean> {
  const outstanding = await db.queryOne(
    sql`SELECT id FROM charges WHERE ownership_id = ${ownershipId} AND status <> 'paid' LIMIT 1`,
  );
  return outstanding === null;
}
