// STR-031: the Admin API member CRUD surface -- `GET`/`POST /v1/members`
// and `GET`/`PATCH /v1/members/{memberId}`, served through RawRoute (the
// STR-003-decided mechanism, see the /v1/health route in aws-blocks/
// index.ts). Thin HTTP adapter: parses path/query/body, then delegates to
// members-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import { requireAuthenticated } from '../http/capability-gate';
import type { Database, Scope } from '@aws-blocks/blocks';
import {
  createMember,
  getMember,
  listMembers,
  updateMember,
  admitMember,
  suspendMember,
  reinstateMember,
  MemberValidationError,
  type MemberStatus,
} from './members-api';
import { sendNotFound, sendValidationError, sendConflictError, ConflictError } from '../http/problem-response';

const MEMBER_STATUSES: readonly MemberStatus[] = ['pending', 'active', 'suspended', 'ceased'];

function isMemberStatus(value: string): value is MemberStatus {
  return (MEMBER_STATUSES as readonly string[]).includes(value);
}

export function registerMemberRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-members', {
    method: 'GET',
    path: '/v1/members',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const status = ctx.request.url.searchParams.get('status') ?? 'all';
      const items = await listMembers(db, { status: status !== 'all' && isMemberStatus(status) ? status : undefined });
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-member', {
    method: 'POST',
    path: '/v1/members',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const input = await ctx.request.json();
      try {
        const member = await createMember(db, input);
        ctx.response.status = 201;
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-member', {
    method: 'GET',
    path: '/v1/members/{memberId}',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const member = await getMember(db, ctx.request.params.memberId);
      if (!member) {
        sendNotFound(ctx, `No member ${ctx.request.params.memberId}`);
        return;
      }
      ctx.response.send(member);
    },
  });

  new RawRoute(scope, 'update-member', {
    method: 'PATCH',
    path: '/v1/members/{memberId}',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const input = await ctx.request.json();
      try {
        const member = await updateMember(db, ctx.request.params.memberId, input);
        if (!member) {
          sendNotFound(ctx, `No member ${ctx.request.params.memberId}`);
          return;
        }
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'admit-member', {
    method: 'POST',
    path: '/v1/members/{memberId}/admit',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      try {
        const member = await admitMember(db, ctx.request.params.memberId);
        if (!member) {
          sendNotFound(ctx, `No member ${ctx.request.params.memberId}`);
          return;
        }
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof ConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'suspend-member', {
    method: 'POST',
    path: '/v1/members/{memberId}/suspend',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { actor } = await ctx.request.json();
      try {
        const member = await suspendMember(db, ctx.request.params.memberId, actor);
        if (!member) {
          sendNotFound(ctx, `No member ${ctx.request.params.memberId}`);
          return;
        }
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        if (e instanceof ConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'reinstate-member', {
    method: 'POST',
    path: '/v1/members/{memberId}/reinstate',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { actor } = await ctx.request.json();
      try {
        const member = await reinstateMember(db, ctx.request.params.memberId, actor);
        if (!member) {
          sendNotFound(ctx, `No member ${ctx.request.params.memberId}`);
          return;
        }
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        if (e instanceof ConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
