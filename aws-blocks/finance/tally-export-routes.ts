// STR-103: the Admin API Tally-export surface -- POST /v1/exports/tally,
// GET /v1/exports/{exportId}, and GET /v1/exports/{exportId}/download,
// served through RawRoute (the STR-003-decided mechanism). Thin HTTP
// adapter following books-routes.ts's shape: parses params/body, then
// delegates to tally-export-jobs.ts for everything else. No auth gate,
// matching books-routes -- the export starts no money movement.
import { RawRoute } from '@aws-blocks/blocks';
import { requireAuthenticated } from '../http/capability-gate';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import {
  sendConflictError,
  sendNotFound,
  sendValidationError,
  ConflictError,
  ValidationError,
} from '../http/problem-response';
import { startTallyExport, getExportJob, getExportDownloadUrl } from './tally-export-jobs';
import type { ExportJobQueue, ExportJobRecord } from './tally-export-jobs';

/** The OpenAPI ExportJob wire shape -- documentPath stays internal (the
 * schema has no such field; the /download route is how the artifact is
 * reached). */
function toWire(job: ExportJobRecord) {
  return {
    export_id: job.exportId,
    kind: job.kind,
    status: job.status,
    from: job.from,
    to: job.to,
    requested_at: job.requestedAt,
    completed_at: job.completedAt,
    failure_reason: job.failureReason,
  };
}

export function registerTallyExportRoutes(
  scope: Scope,
  db: Database,
  bucket: FileBucket,
  exportJob: ExportJobQueue,
): void {
  new RawRoute(scope, 'start-tally-export', {
    method: 'POST',
    path: '/v1/exports/tally',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const body = await ctx.request.json();
      try {
        const job = await startTallyExport(db, exportJob, body?.from ?? '', body?.to ?? '');
        ctx.response.status = 202;
        ctx.response.send(toWire(job));
      } catch (e: unknown) {
        if (e instanceof ValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-export', {
    method: 'GET',
    path: '/v1/exports/{exportId}',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const job = await getExportJob(db, ctx.request.params.exportId);
      if (!job) {
        sendNotFound(ctx, `No export ${ctx.request.params.exportId}`);
        return;
      }
      ctx.response.send(toWire(job));
    },
  });

  new RawRoute(scope, 'download-export', {
    method: 'GET',
    path: '/v1/exports/{exportId}/download',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const result = await getExportDownloadUrl(db, bucket, ctx.request.params.exportId);
      if (result.outcome === 'not_found') {
        sendNotFound(ctx, `No export ${ctx.request.params.exportId}`);
        return;
      }
      if (result.outcome === 'not_completed') {
        sendConflictError(ctx, new ConflictError('Export not yet completed.'));
        return;
      }
      ctx.response.send({ url: result.url, expires_at: result.expiresAt });
    },
  });
}
