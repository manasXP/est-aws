// STR-051: the Admin API asset registry surface -- `POST`/`GET /v1/assets`
// and `PATCH /v1/assets/{assetId}`, served through RawRoute (the
// STR-003-decided mechanism). `GET /v1/assets/{assetId}` (the Admin
// OpenAPI's `AssetDetail`, with `owner_history`) is deliberately not built
// here -- it depends on STR-053's ownership tracking, which doesn't exist
// yet. Thin HTTP adapter: parses path/body, then delegates to
// assets-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { createAsset, listAssets, updateAsset, AssetValidationError } from './assets-api';
import { sendNotFound, sendValidationError } from '../http/problem-response';

export function registerAssetRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-assets', {
    method: 'GET',
    path: '/v1/assets',
    handler: async ctx => {
      const items = await listAssets(db);
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-asset', {
    method: 'POST',
    path: '/v1/assets',
    handler: async ctx => {
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
      const input = await ctx.request.json();
      try {
        const asset = await updateAsset(db, ctx.request.params.assetId, input);
        if (!asset) {
          sendNotFound(ctx, `No asset ${ctx.request.params.assetId}`);
          return;
        }
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
}
