// STR-057: the mobile Public API's PC asset registry surface --
// `GET /v1/pc/projects/{projectId}/assets`, served through RawRoute (the
// STR-003-decided mechanism). Read-only, 403 unless the caller sits on the
// project's PC (Asset Management spec) -- caller identity comes from the
// caller's bearer token (STR-045). Thin HTTP adapter: resolves the actor
// and checks project existence/PC membership, then delegates to
// asset-visibility.ts for the read itself.
//
// Deliberate scope exclusion (recorded here and in the PR body): no
// type/status/cursor/limit query filtering, unlike the sibling Admin
// GET /v1/assets (STR-051) -- T-C2 only requires the full registry, and the
// route's own `next_cursor: null` matches STR-051's still-unimplemented
// pagination.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { isPcMember, listPcProjectAssets } from './asset-visibility';
import { getProject } from '../projects/projects-api';
import { sendCapabilityRequired, sendNotFound } from '../http/problem-response';
import { requireMember } from '../http/capability-gate';

export function registerPcAssetRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-pc-project-assets', {
    method: 'GET',
    path: '/v1/pc/projects/{projectId}/assets',
    handler: async ctx => {
      const { projectId } = ctx.request.params;
      const project = await getProject(db, projectId);
      if (!project) {
        sendNotFound(ctx, `No project ${projectId}`);
        return;
      }

      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }
      if (!(await isPcMember(db, projectId, memberId))) {
        sendCapabilityRequired(ctx, 'pc-member');
        return;
      }

      const items = await listPcProjectAssets(db, projectId);
      ctx.response.send({ items, next_cursor: null });
    },
  });
}
