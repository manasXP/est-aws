// STR-051: the Admin API asset registry surface -- `POST`/`GET /v1/assets`
// and `PATCH /v1/assets/{assetId}`, served through RawRoute (the
// STR-003-decided mechanism). STR-055 adds `GET /v1/assets/{assetId}` (the
// Admin OpenAPI's `AssetDetail`, with `owner_history`). Thin HTTP adapter:
// parses path/body, then delegates to assets-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import { requireAuthenticated } from '../http/capability-gate';
import type { Database, Scope } from '@aws-blocks/blocks';
import { createAsset, listAssets, updateAsset, getAssetDetail, AssetValidationError, AssetConflictError, type AssetType, type AssetStatus } from './assets-api';
import { ASSET_TYPES, WRITABLE_STATUSES } from './asset-types';
import { sendConflictError, sendNotFound, sendValidationError } from '../http/problem-response';

function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}

// The registry also holds `allotted` assets (set only by STR-053's ownership
// assignment, not by this story) -- `status` is filterable to any of the
// three, not just the two this story's writes can produce.
const LISTABLE_STATUSES: readonly AssetStatus[] = [...WRITABLE_STATUSES, 'allotted'];

function isAssetStatus(value: string): value is AssetStatus {
  return (LISTABLE_STATUSES as readonly string[]).includes(value);
}

export function registerAssetRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-assets', {
    method: 'GET',
    path: '/v1/assets',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const projectId = ctx.request.url.searchParams.get('project_id') ?? undefined;
      const type = ctx.request.url.searchParams.get('type') ?? undefined;
      const status = ctx.request.url.searchParams.get('status') ?? 'all';
      const items = await listAssets(db, {
        projectId,
        type: type !== undefined && isAssetType(type) ? type : undefined,
        status: status !== 'all' && isAssetStatus(status) ? status : undefined,
      });
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'get-asset', {
    method: 'GET',
    path: '/v1/assets/{assetId}',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { assetId } = ctx.request.params;
      const detail = await getAssetDetail(db, assetId);
      if (!detail) {
        sendNotFound(ctx, `No asset ${assetId}`);
        return;
      }
      ctx.response.send(detail);
    },
  });

  new RawRoute(scope, 'create-asset', {
    method: 'POST',
    path: '/v1/assets',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const input = await ctx.request.json();
      try {
        const asset = await createAsset(db, input);
        ctx.response.status = 201;
        ctx.response.send(asset);
      } catch (e) {
        if (e instanceof AssetValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'update-asset', {
    method: 'PATCH',
    path: '/v1/assets/{assetId}',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const input = await ctx.request.json();
      try {
        const asset = await updateAsset(db, ctx.request.params.assetId, input);
        if (!asset) {
          sendNotFound(ctx, `No asset ${ctx.request.params.assetId}`);
          return;
        }
        ctx.response.send(asset);
      } catch (e) {
        if (e instanceof AssetConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof AssetValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
