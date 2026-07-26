// STR-057: the mobile Public API's self-service ownerships surface --
// `GET /v1/me/ownerships`, served through RawRoute (the STR-003-decided
// mechanism). The first `/me` mobile route in this repo -- caller identity
// comes from the `X-Actor-Member-Id` stub header, the same convention
// aws-blocks/http/capability-gate.ts established for the Admin API. Thin
// HTTP adapter: resolves the actor, then delegates to asset-visibility.ts
// for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { listMemberOwnershipsWithAssets } from './asset-visibility';
import { sendUnauthorized } from '../http/problem-response';

export function registerMeOwnershipRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-me-ownerships', {
    method: 'GET',
    path: '/v1/me/ownerships',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }
      const items = await listMemberOwnershipsWithAssets(db, memberId);
      ctx.response.send({ items });
    },
  });
}
