// STR-053: the Admin API ownership allotment surface -- `POST`/`GET
// /v1/members/{memberId}/ownerships` and `PATCH /v1/ownerships/{ownershipId}`,
// served through RawRoute (the STR-003-decided mechanism). `POST
// /v1/ownerships/{ownershipId}/transfer` is deliberately not built here --
// it's STR-055. Thin HTTP adapter: parses path/body, then delegates to
// ownerships-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import {
  createOwnership,
  listOwnershipsForMember,
  updateOwnership,
  OwnershipValidationError,
  OwnershipConflictError,
} from './ownerships-api';
import { getMember } from '../members/members-api';
import { sendConflictError, sendNotFound, sendValidationError } from '../http/problem-response';

export function registerOwnershipRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-member-ownerships', {
    method: 'GET',
    path: '/v1/members/{memberId}/ownerships',
    handler: async ctx => {
      const { memberId } = ctx.request.params;
      const member = await getMember(db, memberId);
      if (!member) {
        sendNotFound(ctx, `No member ${memberId}`);
        return;
      }
      const items = await listOwnershipsForMember(db, memberId);
      ctx.response.send({ items });
    },
  });

  new RawRoute(scope, 'create-ownership', {
    method: 'POST',
    path: '/v1/members/{memberId}/ownerships',
    handler: async ctx => {
      const { memberId } = ctx.request.params;
      const input = await ctx.request.json();
      try {
        const ownership = await createOwnership(db, memberId, input);
        ctx.response.status = 201;
        ctx.response.send(ownership);
      } catch (e) {
        if (e instanceof OwnershipConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof OwnershipValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'update-ownership', {
    method: 'PATCH',
    path: '/v1/ownerships/{ownershipId}',
    handler: async ctx => {
      const { ownershipId } = ctx.request.params;
      const input = await ctx.request.json();
      try {
        const ownership = await updateOwnership(db, ownershipId, input);
        if (!ownership) {
          sendNotFound(ctx, `No ownership ${ownershipId}`);
          return;
        }
        ctx.response.send(ownership);
      } catch (e) {
        if (e instanceof OwnershipValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
