// STR-111: the Admin API document registration/read surface --
// `POST /v1/documents`, `GET /v1/documents/{documentId}`, and
// `GET /v1/documents/{documentId}/download`, served through RawRoute (the
// STR-003-decided mechanism). Thin HTTP adapter: parses path/body, then
// delegates to documents-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import { registerDocument, getDocument, getDownloadUrl, updateDocument, DocumentValidationError, DOWNLOAD_URL_EXPIRES_IN_SECONDS } from './documents-api';
import type { DocumentRecord } from './documents-api';
import { sendNotFound, sendValidationError, sendUnauthorized, problemResponse } from '../http/problem-response';
import { resolveActor } from '../http/capability-gate';

// The Admin OpenAPI's Document schema types `size_bytes` as a plain
// non-nullable integer, absent from `required` -- so when it's still `null`
// in the DB (checksum not yet verified, T-U5), the key must be omitted
// entirely (`undefined`), never sent as `size_bytes: null`, or the response
// fails schema validation. `checksum` IS nullable in the schema, so it's
// always sent explicitly.
function toDocumentResponse(doc: DocumentRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    document_id: doc.documentId,
    level: doc.level,
    project_id: doc.projectId,
    member_id: doc.memberId,
    title: doc.title,
    category: doc.category,
    tags: doc.tags,
    notes: doc.notes,
    file_name: doc.fileName,
    mime_type: doc.mimeType,
    checksum: doc.checksum,
    status: doc.status,
    member_visible: doc.memberVisible,
    uploaded_by: doc.uploadedBy,
    uploaded_at: doc.uploadedAt,
  };
  if (doc.sizeBytes !== null) {
    body.size_bytes = doc.sizeBytes;
  }
  return body;
}

export function registerDocumentRoutes(scope: Scope, db: Database, bucket: FileBucket): void {
  new RawRoute(scope, 'create-document', {
    method: 'POST',
    path: '/v1/documents',
    handler: async ctx => {
      const actor = resolveActor(ctx);
      if (!actor) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id or X-Actor-Member-Id header is required.');
        return;
      }
      const uploadedBy = 'employeeId' in actor ? actor.employeeId : actor.memberId;

      const body = await ctx.request.json();
      try {
        const result = await registerDocument(db, bucket, {
          level: body?.level,
          projectId: body?.project_id ?? null,
          memberId: body?.member_id ?? null,
          title: body?.title,
          category: body?.category,
          tags: body?.tags,
          notes: body?.notes,
          memberVisible: body?.member_visible,
          filename: body?.filename,
          contentType: body?.content_type,
          uploadedBy,
        });
        ctx.response.status = 201;
        ctx.response.send({
          document_id: result.documentId,
          upload_url: result.uploadUrl,
          expires_at: result.expiresAt,
        });
      } catch (e) {
        if (e instanceof DocumentValidationError) {
          if (e.code === 'unknown_category') {
            ctx.response.status = 422;
            ctx.response.send(problemResponse('unknown_category', e.message));
            return;
          }
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'get-document', {
    method: 'GET',
    path: '/v1/documents/{documentId}',
    handler: async ctx => {
      const { documentId } = ctx.request.params;
      const doc = await getDocument(db, bucket, documentId);
      if (!doc) {
        sendNotFound(ctx, `No document ${documentId}`);
        return;
      }
      ctx.response.send(toDocumentResponse(doc));
    },
  });

  new RawRoute(scope, 'update-document', {
    method: 'PATCH',
    path: '/v1/documents/{documentId}',
    handler: async ctx => {
      const actor = resolveActor(ctx);
      if (!actor) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id or X-Actor-Member-Id header is required.');
        return;
      }

      const body = await ctx.request.json();
      try {
        // Only the four STR-112 metadata fields are passed through --
        // `member_visible` (and anything else in the body) is dropped
        // silently until STR-115 makes the flag writable.
        const doc = await updateDocument(db, ctx.request.params.documentId, {
          ...(body?.title !== undefined && { title: body.title }),
          ...(body?.category !== undefined && { category: body.category }),
          ...(body?.tags !== undefined && { tags: body.tags }),
          ...(body?.notes !== undefined && { notes: body.notes }),
        }, actor);
        if (!doc) {
          sendNotFound(ctx, `No document ${ctx.request.params.documentId}`);
          return;
        }
        ctx.response.send(toDocumentResponse(doc));
      } catch (e) {
        if (e instanceof DocumentValidationError) {
          if (e.code === 'unknown_category') {
            ctx.response.status = 422;
            ctx.response.send(problemResponse('unknown_category', e.message));
            return;
          }
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'download-document', {
    method: 'GET',
    path: '/v1/documents/{documentId}/download',
    handler: async ctx => {
      const { documentId } = ctx.request.params;
      const downloadUrl = await getDownloadUrl(db, bucket, documentId);
      if (!downloadUrl) {
        sendNotFound(ctx, `No document ${documentId}`);
        return;
      }
      const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();
      ctx.response.send({ download_url: downloadUrl, expires_at: expiresAt });
    },
  });
}
