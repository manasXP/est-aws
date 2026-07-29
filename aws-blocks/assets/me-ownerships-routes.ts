// STR-057: the mobile Public API's self-service ownerships surface --
// `GET /v1/me/ownerships`, served through RawRoute (the STR-003-decided
// mechanism). The first `/me` mobile route in this repo -- caller identity
// comes from the caller's own bearer token (STR-045), the same convention
// aws-blocks/http/capability-gate.ts established for the Admin API. Thin
// HTTP adapter: resolves the actor, then delegates to asset-visibility.ts
// for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { listMemberOwnershipsWithAssets } from './asset-visibility';
import { requireMember } from '../http/capability-gate';

export function registerMeOwnershipRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-me-ownerships', {
    method: 'GET',
    path: '/v1/me/ownerships',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }
      const items = await listMemberOwnershipsWithAssets(db, memberId);
      ctx.response.send({ items });
    },
  });
}
