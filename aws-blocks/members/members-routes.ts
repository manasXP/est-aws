// STR-031: the Admin API member CRUD surface -- `GET`/`POST /v1/members`
// and `GET`/`PATCH /v1/members/{memberId}`, served through RawRoute (the
// STR-003-decided mechanism, see the /v1/health route in aws-blocks/
// index.ts). Thin HTTP adapter: parses path/query/body, then delegates to
// members-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { createMember, getMember, listMembers, updateMember, MemberValidationError, type MemberStatus } from './members-api';

const MEMBER_STATUSES: readonly MemberStatus[] = ['pending', 'active', 'suspended', 'ceased'];

function isMemberStatus(value: string): value is MemberStatus {
  return (MEMBER_STATUSES as readonly string[]).includes(value);
}

export function registerMemberRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-members', {
    method: 'GET',
    path: '/v1/members',
    handler: async ctx => {
      const status = ctx.request.url.searchParams.get('status') ?? 'all';
      const items = await listMembers(db, { status: status !== 'all' && isMemberStatus(status) ? status : undefined });
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-member', {
    method: 'POST',
    path: '/v1/members',
    handler: async ctx => {
      const input = await ctx.request.json();
      const member = await createMember(db, input);
      ctx.response.status = 201;
      ctx.response.send(member);
    },
  });

  new RawRoute(scope, 'get-member', {
    method: 'GET',
    path: '/v1/members/{memberId}',
    handler: async ctx => {
      const member = await getMember(db, ctx.request.params.memberId);
      if (!member) {
        ctx.response.status = 404;
        ctx.response.send({ error: { code: 'not_found', message: `No member ${ctx.request.params.memberId}` } });
        return;
      }
      ctx.response.send(member);
    },
  });

  new RawRoute(scope, 'update-member', {
    method: 'PATCH',
    path: '/v1/members/{memberId}',
    handler: async ctx => {
      const input = await ctx.request.json();
      try {
        const member = await updateMember(db, ctx.request.params.memberId, input);
        if (!member) {
          ctx.response.status = 404;
          ctx.response.send({ error: { code: 'not_found', message: `No member ${ctx.request.params.memberId}` } });
          return;
        }
        ctx.response.send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          ctx.response.status = 422;
          ctx.response.send({ error: { code: 'validation_error', message: e.message } });
          return;
        }
        throw e;
      }
    },
  });
}
