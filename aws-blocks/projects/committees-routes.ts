// STR-043: the Admin API project committee (PC) surface -- `GET`/`PUT
// /v1/projects/{projectId}/committee`, served through RawRoute (the
// STR-003-decided mechanism, see the /v1/health route in aws-blocks/
// index.ts). Thin HTTP adapter: parses path/body, then delegates to
// committees-api.ts for everything else -- no independent eligibility
// logic here, so the 422 mapping below can never diverge from the domain
// rule it catches.
import { RawRoute } from '@aws-blocks/blocks';
import { requireAuthenticated } from '../http/capability-gate';
import type { Database, Scope } from '@aws-blocks/blocks';
import { getProjectCommittee, setProjectCommittee, CommitteeEligibilityError } from './committees-api';
import { sendNotFound, sendValidationError } from '../http/problem-response';

export function registerProjectCommitteeRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'get-project-committee', {
    method: 'GET',
    path: '/v1/projects/{projectId}/committee',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const committee = await getProjectCommittee(db, ctx.request.params.projectId);
      if (!committee) {
        sendNotFound(ctx, `No project ${ctx.request.params.projectId}`);
        return;
      }
      ctx.response.send(committee);
    },
  });

  new RawRoute(scope, 'set-project-committee', {
    method: 'PUT',
    path: '/v1/projects/{projectId}/committee',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const input = await ctx.request.json();
      try {
        const committee = await setProjectCommittee(db, ctx.request.params.projectId, input);
        if (!committee) {
          sendNotFound(ctx, `No project ${ctx.request.params.projectId}`);
          return;
        }
        ctx.response.send(committee);
      } catch (e) {
        if (e instanceof CommitteeEligibilityError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
