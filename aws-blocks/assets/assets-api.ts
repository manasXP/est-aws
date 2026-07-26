// STR-051: the asset registry's business logic, sitting between the
// `assets` table (migrations/007_assets.sql) and the HTTP layer
// (aws-blocks/assets/assets-routes.ts) -- kept separate so it's testable
// with a plain Database, no HTTP dispatch required (test/assets/
// assets-api.test.ts). Mirrors the projects-api.ts / members-api.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import { type AssetType, type AssetStatus, ASSET_TYPES, WRITABLE_STATUSES } from './asset-types';

export type { AssetType, AssetStatus };

/** The Admin OpenAPI's Asset shape (components/schemas/Asset), restricted
 * to what this story owns -- current_ownership_id/current_owner are always
 * null here; allotment and owner history are STR-053. */
export interface Asset {
  asset_id: string;
  project_id: string;
  type: AssetType;
  label?: string;
  attributes?: Record<string, unknown>;
  status: AssetStatus;
  current_ownership_id: null;
  current_owner: null;
  created_at: string;
  updated_at: string;
}

/** The Admin OpenAPI's AssetInput shape. */
export interface AssetInput {
  project_id?: string;
  type?: string;
  label?: string | null;
  attributes?: Record<string, unknown> | null;
  status?: string;
}

/** Domain rejection for a create/update carrying an invalid attribute.
 * Nothing is written when this is thrown. */
export class AssetValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'AssetValidationError';
  }
}

interface AssetRow {
  id: string;
  project_id: string;
  type: AssetType;
  label: string | null;
  attributes: string | null;
  status: AssetStatus;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** A caller-supplied label counts as "carrying a label" only if it's a
 * non-blank string -- an explicit `''` is treated the same as omitting it,
 * so a dividend asset can never end up with a stored label either way. */
function hasLabel(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.trim() !== '';
}

function toAsset(row: AssetRow): Asset {
  const asset: Asset = {
    asset_id: row.id,
    project_id: row.project_id,
    type: row.type,
    status: row.status,
    current_ownership_id: null,
    current_owner: null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
  if (row.label !== null) asset.label = row.label;
  if (row.attributes !== null) asset.attributes = JSON.parse(row.attributes);
  return asset;
}

/**
 * `POST /assets` -- an asset always belongs to exactly one existing
 * project; created `available` unless `society_retained` is requested.
 * `dividend` assets never carry a label (AC3).
 */
export async function createAsset(db: Database, input: AssetInput): Promise<Asset> {
  if (typeof input.project_id !== 'string' || input.project_id.trim() === '') {
    throw new AssetValidationError('project_id is required.');
  }
  if (typeof input.type !== 'string' || !ASSET_TYPES.includes(input.type as AssetType)) {
    throw new AssetValidationError(`type must be one of ${ASSET_TYPES.join(', ')}.`);
  }
  if (input.type === 'dividend' && hasLabel(input.label)) {
    throw new AssetValidationError('dividend assets cannot carry a label.');
  }
  const status = input.status ?? 'available';
  if (!WRITABLE_STATUSES.includes(status as AssetStatus)) {
    throw new AssetValidationError(`status must be one of ${WRITABLE_STATUSES.join(', ')} on create.`);
  }
  const project = await db.queryOne(sql`SELECT id FROM projects WHERE id = ${input.project_id}`);
  if (!project) {
    throw new AssetValidationError(`No project ${input.project_id}.`);
  }

  const storedLabel = input.type === 'dividend' ? null : input.label ?? null;
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO assets (id, project_id, type, label, attributes, status)
        VALUES (${id}, ${input.project_id}, ${input.type}, ${storedLabel}, ${input.attributes ? JSON.stringify(input.attributes) : null}, ${status})`,
  );
  const asset = await getAsset(db, id);
  return asset!;
}

/**
 * A single asset, or `null` if it doesn't exist. Not exposed as its own
 * route this story -- `GET /assets/{assetId}` in the Admin OpenAPI returns
 * `AssetDetail` with `owner_history`, which depends on STR-053's ownership
 * tracking (not built yet). Used internally by createAsset/updateAsset.
 */
export async function getAsset(db: Database, assetId: string): Promise<Asset | null> {
  const row = await db.queryOne<AssetRow>(sql`SELECT * FROM assets WHERE id = ${assetId}`);
  return row ? toAsset(row) : null;
}

export interface ListAssetsOptions {
  projectId?: string;
  type?: AssetType;
  status?: AssetStatus;
}

/** `GET /assets` -- every asset, optionally filtered by `project_id`,
 * `type`, and/or `status` (Admin OpenAPI query params). Filters in
 * application code rather than a dynamically-composed WHERE clause -- the
 * `sql` tag only parameterizes values inside one literal template, it
 * doesn't support building up a query from conditional fragments. */
export async function listAssets(db: Database, options: ListAssetsOptions = {}): Promise<Asset[]> {
  const rows = await db.query<AssetRow>(sql`SELECT * FROM assets ORDER BY id`);
  return rows
    .map(toAsset)
    .filter(a => options.projectId === undefined || a.project_id === options.projectId)
    .filter(a => options.type === undefined || a.type === options.type)
    .filter(a => options.status === undefined || a.status === options.status);
}

/**
 * `PATCH /assets/{assetId}` -- edits label/attributes/status. `project_id`
 * and `type` are immutable (Admin OpenAPI's AssetInput description) and
 * rejected if the caller attempts to change them. `status` may only move
 * between `available` and `society_retained` -- `allotted` can't yet arise
 * (STR-053 not built), so the 409-while-allotted guard is deferred to that
 * story. Returns `null` if the asset doesn't exist.
 */
export async function updateAsset(db: Database, assetId: string, input: AssetInput): Promise<Asset | null> {
  const existing = await getAsset(db, assetId);
  if (!existing) return null;

  if (input.project_id !== undefined && input.project_id !== existing.project_id) {
    throw new AssetValidationError('project_id is immutable.');
  }
  if (input.type !== undefined && input.type !== existing.type) {
    throw new AssetValidationError('type is immutable.');
  }
  if (input.status !== undefined && !WRITABLE_STATUSES.includes(input.status as AssetStatus)) {
    throw new AssetValidationError(`status must be one of ${WRITABLE_STATUSES.join(', ')}.`);
  }
  if (existing.type === 'dividend' && 'label' in input && hasLabel(input.label)) {
    throw new AssetValidationError('dividend assets cannot carry a label.');
  }

  const nextLabel = existing.type === 'dividend' ? null : 'label' in input ? input.label ?? null : existing.label ?? null;
  const nextAttributes = 'attributes' in input ? input.attributes ?? null : existing.attributes ?? null;
  const nextStatus = input.status ?? existing.status;

  await db.execute(
    sql`UPDATE assets SET
          label = ${nextLabel},
          attributes = ${nextAttributes ? JSON.stringify(nextAttributes) : null},
          status = ${nextStatus},
          updated_at = now()
        WHERE id = ${assetId}`,
  );
  return getAsset(db, assetId);
}
