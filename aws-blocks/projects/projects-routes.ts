// STR-031: the Admin API project CRUD surface -- `GET`/`POST /v1/projects`
// and `GET`/`PATCH /v1/projects/{projectId}`, served through RawRoute (the
// STR-003-decided mechanism, see the /v1/health route in aws-blocks/
// index.ts). Thin HTTP adapter: parses path/body, then delegates to
// projects-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { createProject, getProject, listProjects, updateProject, ProjectValidationError } from './projects-api';
import { sendNotFound, sendValidationError } from '../http/problem-response';

export function registerProjectRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'list-projects', {
    method: 'GET',
    path: '/v1/projects',
    handler: async ctx => {
      const items = await listProjects(db);
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'create-project', {
    method: 'POST',
    path: '/v1/projects',
    handler: async ctx => {
      const input = await ctx.request.json();
      try {
        const project = await createProject(db, input);
        ctx.response.status = 201;
        ctx.response.send(project);
      } catch (e) {
        if (e instanceof ProjectValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-project', {
    method: 'GET',
    path: '/v1/projects/{projectId}',
    handler: async ctx => {
      const project = await getProject(db, ctx.request.params.projectId);
      if (!project) {
        sendNotFound(ctx, `No project ${ctx.request.params.projectId}`);
        return;
      }
      ctx.response.send(project);
    },
  });

  new RawRoute(scope, 'update-project', {
    method: 'PATCH',
    path: '/v1/projects/{projectId}',
    handler: async ctx => {
      const input = await ctx.request.json();
      const project = await updateProject(db, ctx.request.params.projectId, input);
      if (!project) {
        sendNotFound(ctx, `No project ${ctx.request.params.projectId}`);
        return;
      }
      ctx.response.send(project);
    },
  });
}
