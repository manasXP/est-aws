// STR-053: ownership allotment business logic, sitting between the
// `ownerships` table (migrations/014_ownerships.sql) and the HTTP layer
// (aws-blocks/assets/ownerships-routes.ts) -- kept separate so it's testable
// with a plain Database, no HTTP dispatch required (test/assets/
// ownerships-api.test.ts). Mirrors the assets-api.ts / assets-routes.ts
// split (STR-051).
import { randomUUID } from 'node:crypto';
import { DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ConflictError, ValidationError } from '../http/problem-response';
import type { AssetType } from './assets-api';
import { reassignAsset } from './asset-state';
import { getMember } from '../members/members-api';
import { isOwnershipSettled } from './ownership-settlement';

/** The Admin OpenAPI's Ownership shape (components/schemas/Ownership).
 * `project_id` is derived at read time from a join against `assets` --
 * never stored redundantly on the ownerships row. `asset` (the embedded
 * read-only Asset) is optional in the schema and not populated here. */
export interface Ownership {
  ownership_id: string;
  member_id: string;
  project_id: string;
  asset_id: string;
  co_owner_names?: string[];
}

/** The Admin OpenAPI's OwnershipInput shape -- `asset_id` required on
 * create, immutable on PATCH (only `co_owner_names` may change there). */
export interface OwnershipInput {
  asset_id?: string;
  co_owner_names?: string[] | null;
}

/** Domain rejection for a create/update carrying an invalid or immutable
 * attribute. Nothing is written when this is thrown. */
export class OwnershipValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipValidationError';
  }
}

/** The asset referenced by `asset_id` is already allotted (409) --
 * assignment is rejected, writing nothing. */
export class OwnershipConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipConflictError';
  }
}

interface OwnershipRow {
  id: string;
  member_id: string;
  asset_id: string;
  co_owner_names: string | null;
  project_id: string;
  // STR-055: null means "currently open/active"; once set, never unset or
  // changed again (AC2, append-only). Not part of the public Ownership
  // shape (the OpenAPI Ownership schema has no closed_at field) -- carried
  // on the internal row only, for updateOwnership's/transferOwnership's own
  // guards.
  closed_at: string | Date | null;
}

function toOwnership(row: OwnershipRow): Ownership {
  const ownership: Ownership = {
    ownership_id: row.id,
    member_id: row.member_id,
    project_id: row.project_id,
    asset_id: row.asset_id,
  };
  if (row.co_owner_names !== null) ownership.co_owner_names = JSON.parse(row.co_owner_names);
  return ownership;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/**
 * `POST /members/{memberId}/ownerships` -- assigns an existing `available`
 * asset to the member by `asset_id`. The allotment is a single transaction
 * (Definition of Done): a guarded `UPDATE assets ... WHERE status =
 * 'available'` re-points the asset before the `ownerships` row is inserted,
 * so a concurrent second assignment against the same asset sees rowCount 0
 * and is rejected as a conflict -- ordinary row-level locking makes this
 * safe under concurrent attempts (AC2), no application-level locking needed.
 */
export async function createOwnership(db: Database, memberId: string, input: OwnershipInput): Promise<Ownership> {
  if (typeof input.asset_id !== 'string' || input.asset_id.trim() === '') {
    throw new OwnershipValidationError('asset_id is required.');
  }
  if (input.co_owner_names !== undefined && input.co_owner_names !== null && !isStringArray(input.co_owner_names)) {
    throw new OwnershipValidationError('co_owner_names must be an array of strings.');
  }

  const member = await db.queryOne(sql`SELECT id FROM members WHERE id = ${memberId}`);
  if (!member) {
    throw new OwnershipValidationError(`No member ${memberId}.`);
  }

  const assetId = input.asset_id;
  const id = randomUUID();
  const coOwnerNames = input.co_owner_names ?? null;

  try {
    await db.transaction(async tx => {
      const reassigned = await reassignAsset(tx, assetId, 'available', 'allotted', id);
      if (!reassigned.ok) {
        if (reassigned.reason === 'not_found') {
          throw new OwnershipValidationError(`No asset ${assetId}.`);
        }
        throw new OwnershipConflictError(`Asset ${assetId} is already allotted.`);
      }
      await tx.execute(
        sql`INSERT INTO ownerships (id, member_id, asset_id, co_owner_names)
            VALUES (${id}, ${memberId}, ${assetId}, ${coOwnerNames ? JSON.stringify(coOwnerNames) : null})`,
      );
    });
  } catch (e: unknown) {
    if (e instanceof OwnershipValidationError || e instanceof OwnershipConflictError) {
      throw e;
    }
    // Belt-and-suspenders (same pattern as aws-blocks/finance/reversal.ts):
    // migrations/014_ownerships.sql's UNIQUE constraint on asset_id backstops
    // the guarded UPDATE above in case it's ever bypassed.
    if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
      throw new OwnershipConflictError(`Asset ${assetId} is already allotted.`);
    }
    throw e;
  }

  const ownership = await getOwnership(db, id);
  return ownership!;
}

/** STR-055: the raw row (including `closed_at`), needed by both
 * updateOwnership's and transferOwnership's own immutability/state guards --
 * `getOwnership` below only exposes the public Ownership shape. */
async function getOwnershipRow(db: Database, ownershipId: string): Promise<OwnershipRow | null> {
  return db.queryOne<OwnershipRow>(
    sql`SELECT o.*, a.project_id AS project_id FROM ownerships o JOIN assets a ON a.id = o.asset_id WHERE o.id = ${ownershipId}`,
  );
}

/** A single ownership, with `project_id` joined from its asset, or `null`
 * if it doesn't exist. */
export async function getOwnership(db: Database, ownershipId: string): Promise<Ownership | null> {
  const row = await getOwnershipRow(db, ownershipId);
  return row ? toOwnership(row) : null;
}

/** `GET /members/{memberId}/ownerships` -- every ownership of the member. */
export async function listOwnershipsForMember(db: Database, memberId: string): Promise<Ownership[]> {
  const rows = await db.query<OwnershipRow>(
    sql`SELECT o.*, a.project_id AS project_id FROM ownerships o JOIN assets a ON a.id = o.asset_id WHERE o.member_id = ${memberId} ORDER BY o.id`,
  );
  return rows.map(toOwnership);
}

/**
 * `PATCH /ownerships/{ownershipId}` -- amends `co_owner_names` only.
 * `asset_id`/`member_id` are rejected if present, writing nothing --
 * `current_ownership` is only ever re-pointed by assignment/transfer
 * (TC-AST-023), never a raw PATCH. Returns `null` if the ownership doesn't
 * exist. STR-055 AC2: a closed ownership record is immutable -- rejected
 * (422, same status family as the asset_id/member_id checks above; the
 * OpenAPI PATCH declares no 409) once `closed_at` is set.
 */
export async function updateOwnership(
  db: Database,
  ownershipId: string,
  input: OwnershipInput & { member_id?: unknown },
): Promise<Ownership | null> {
  if ('asset_id' in input) {
    throw new OwnershipValidationError('asset_id is immutable; transfer is the only way an asset changes hands.');
  }
  if ('member_id' in input) {
    throw new OwnershipValidationError('member_id cannot be changed by PATCH; transfer is the only way an asset changes hands.');
  }
  if (input.co_owner_names !== undefined && input.co_owner_names !== null && !isStringArray(input.co_owner_names)) {
    throw new OwnershipValidationError('co_owner_names must be an array of strings.');
  }

  const existingRow = await getOwnershipRow(db, ownershipId);
  if (!existingRow) return null;
  if (existingRow.closed_at !== null) {
    throw new OwnershipValidationError(`Ownership ${ownershipId} is closed; closed ownership records are immutable.`);
  }
  const existing = toOwnership(existingRow);

  const nextCoOwnerNames = 'co_owner_names' in input ? input.co_owner_names ?? null : existing.co_owner_names ?? null;
  await db.execute(
    sql`UPDATE ownerships SET co_owner_names = ${nextCoOwnerNames ? JSON.stringify(nextCoOwnerNames) : null}, updated_at = now()
        WHERE id = ${ownershipId}`,
  );
  return getOwnership(db, ownershipId);
}

/** The billable-asset basis E07's charge run will consume: every ownership
 * joined with its asset's type, no type filtering -- a `dividend` holding
 * appears identically to a `flat`/`plot`/`villa` (TC-AST-005; charged like
 * any owned asset, never paid -- that logic belongs to E07, not built yet). */
export interface BillableOwnership {
  ownership_id: string;
  member_id: string;
  asset_id: string;
  asset_type: AssetType;
}

export async function listBillableOwnerships(db: Database): Promise<BillableOwnership[]> {
  // STR-055 AC4: scoped to open ownerships only -- once a transfer can
  // close one and create another for the same asset, an unfiltered query
  // would double-count the asset (the old closed ownership alongside the
  // new one it was re-pointed to).
  const rows = await db.query<{ id: string; member_id: string; asset_id: string; type: AssetType }>(
    sql`SELECT o.id, o.member_id, o.asset_id, a.type FROM ownerships o JOIN assets a ON a.id = o.asset_id WHERE o.closed_at IS NULL ORDER BY o.id`,
  );
  return rows.map(row => ({ ownership_id: row.id, member_id: row.member_id, asset_id: row.asset_id, asset_type: row.type }));
}

/**
 * `POST /ownerships/{ownershipId}/transfer` -- closes this ownership record
 * and creates a new one for `to_member_id` (records are never rewritten,
 * TC-AST-021), re-pointing the asset's `current_ownership_id` to the new
 * record. Rejected (409) while the ownership carries outstanding charges
 * (TC-AST-020, the settlement gate) or is already closed. Rejected (422) if
 * `to_member_id` is missing or doesn't reference an existing member.
 * Returns `null` if the ownership doesn't exist.
 *
 * `notes` has no home in the Ownership schema and no audit-log table exists
 * in this repo yet -- accepted but not persisted (not rejected as an
 * unrecognized field either).
 */
export async function transferOwnership(
  db: Database,
  ownershipId: string,
  input: { to_member_id?: unknown; notes?: unknown },
): Promise<Ownership | null> {
  if (typeof input.to_member_id !== 'string' || input.to_member_id.trim() === '') {
    throw new OwnershipValidationError('to_member_id is required.');
  }
  const toMemberId = input.to_member_id;

  const existingRow = await getOwnershipRow(db, ownershipId);
  if (!existingRow) return null;
  if (existingRow.closed_at !== null) {
    throw new OwnershipConflictError(`Ownership ${ownershipId} is already closed.`);
  }

  const settled = await isOwnershipSettled(db, ownershipId);
  if (!settled) {
    throw new OwnershipConflictError(`Ownership ${ownershipId} has unsettled charges; settle before transfer.`);
  }

  const toMember = await getMember(db, toMemberId);
  if (!toMember) {
    throw new OwnershipValidationError(`No member ${toMemberId}.`);
  }

  const assetId = existingRow.asset_id;
  const newId = randomUUID();

  await db.transaction(async tx => {
    const closed = await tx.execute(
      sql`UPDATE ownerships SET closed_at = now(), updated_at = now() WHERE id = ${ownershipId} AND closed_at IS NULL`,
    );
    if (closed.rowCount === 0) {
      // Race: closed by another call between the read above and this
      // guarded UPDATE -- ordinary row-level locking makes this safe under
      // concurrent attempts, same pattern as reassignAsset below.
      throw new OwnershipConflictError(`Ownership ${ownershipId} was already closed.`);
    }

    const reassigned = await reassignAsset(tx, assetId, 'allotted', 'allotted', newId);
    if (!reassigned.ok) {
      throw new OwnershipConflictError(`Asset ${assetId} could not be re-pointed.`);
    }

    // A transfer starts a fresh holding -- co_owner_names is not carried
    // over from the closed record (nothing in the schema or story ACs says
    // otherwise).
    await tx.execute(
      sql`INSERT INTO ownerships (id, member_id, asset_id, co_owner_names) VALUES (${newId}, ${toMemberId}, ${assetId}, NULL)`,
    );
  });

  return getOwnership(db, newId);
}
