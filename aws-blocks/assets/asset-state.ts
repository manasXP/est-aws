// STR-053 Refactor: the guarded pointer re-point that STR-055's transfer
// will reuse -- an atomic "flip an asset's status/current_ownership_id, but
// only if it's currently in the expected state" primitive, extracted out of
// ownerships-api.ts's createOwnership. A single UPDATE statement, so
// ordinary row-level locking makes this safe under concurrent callers with
// no application-level locking (AC2) -- the caller must run it inside the
// same transaction as the ownerships row write it backs (assets.
// current_ownership_id is a DEFERRABLE FK against ownerships.id, see
// migrations/008_ownerships.sql, so that row doesn't need to exist yet when
// this runs).
import { sql } from '@aws-blocks/blocks';
import type { Transaction } from '@aws-blocks/blocks';
import type { AssetStatus } from './asset-types';

export type ReassignAssetResult = { ok: true } | { ok: false; reason: 'not_found' | 'conflict' };

/**
 * Sets `status` to `nextStatus` and `current_ownership_id` to `ownershipId`
 * on the asset `assetId`, but only if its current `status` is
 * `expectedStatus`. If the guard doesn't match, distinguishes "the asset
 * doesn't exist at all" from "it exists but isn't in the expected state" --
 * the caller maps these to its own not-found/conflict responses.
 */
export async function reassignAsset(
  tx: Transaction,
  assetId: string,
  expectedStatus: AssetStatus,
  nextStatus: AssetStatus,
  ownershipId: string,
): Promise<ReassignAssetResult> {
  const result = await tx.execute(
    sql`UPDATE assets SET status = ${nextStatus}, current_ownership_id = ${ownershipId}, updated_at = now()
        WHERE id = ${assetId} AND status = ${expectedStatus}`,
  );
  if (result.rowCount > 0) return { ok: true };

  const asset = await tx.queryOne(sql`SELECT id FROM assets WHERE id = ${assetId}`);
  return { ok: false, reason: asset ? 'conflict' : 'not_found' };
}
