// STR-111: the Admin API document registration/read surface --
// `POST /v1/documents`, `GET /v1/documents/{documentId}`, and
// `GET /v1/documents/{documentId}/download`, served through RawRoute (the
// STR-003-decided mechanism). Thin HTTP adapter: parses path/body, then
// delegates to documents-api.ts for everything else.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import { registerDocument, getDocument, getDownloadUrl, updateDocument, listDocuments, listCategories, replaceCategories, archiveDocument, restoreDocument, DocumentValidationError, DocumentCategoryConflictError, DocumentLifecycleConflictError, DOWNLOAD_URL_EXPIRES_IN_SECONDS } from './documents-api';
import type { DocumentRecord, DocumentLevel, DocumentStatus } from './documents-api';
import { sendNotFound, sendValidationError, sendConflictError, problemResponse } from '../http/problem-response';
import { requireAuthenticated } from '../http/capability-gate';

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
  // STR-115: the search surface (TC-DOC-040). `cursor`/`limit` are accepted
  // per the contract but `next_cursor` is always null — the STR-051
  // precedent; no story has built real cursoring yet.
  new RawRoute(scope, 'list-documents', {
    method: 'GET',
    path: '/v1/documents',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const params = ctx.request.url.searchParams;
      const status = params.get('status') ?? 'active';
      const level = params.get('level');
      try {
        if (status !== 'active' && status !== 'archived' && status !== 'all') {
          throw new DocumentValidationError('status must be one of active, archived, all.');
        }
        if (level !== null && level !== 'society' && level !== 'project' && level !== 'member') {
          throw new DocumentValidationError('level must be one of society, project, member.');
        }
        const items = await listDocuments(db, {
          status: status as DocumentStatus | 'all',
          level: (level as DocumentLevel | null) ?? undefined,
          projectId: params.get('project_id') ?? undefined,
          memberId: params.get('member_id') ?? undefined,
          // `|| undefined`, not `??`: `?q=` (empty string) must mean "no
          // filter" — plainto_tsquery('') is the empty tsquery, which
          // matches nothing and would silently empty the whole registry.
          q: params.get('q') || undefined,
          category: params.get('category') ?? undefined,
          uploadedFrom: params.get('uploaded_from') ?? undefined,
          uploadedTo: params.get('uploaded_to') ?? undefined,
        });
        ctx.response.send({ items: items.map(toDocumentResponse), next_cursor: null });
      } catch (e) {
        if (e instanceof DocumentValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'create-document', {
    method: 'POST',
    path: '/v1/documents',
    handler: async ctx => {
      const actor = await requireAuthenticated(ctx, db);
      if (!actor) return;
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
      if (!(await requireAuthenticated(ctx, db))) return;

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
      const actor = await requireAuthenticated(ctx, db);
      if (!actor) return;

      const body = await ctx.request.json();
      try {
        // The four STR-112 metadata fields plus STR-115's member_visible --
        // anything else in the body is dropped silently.
        const doc = await updateDocument(db, ctx.request.params.documentId, {
          ...(body?.title !== undefined && { title: body.title }),
          ...(body?.category !== undefined && { category: body.category }),
          ...(body?.tags !== undefined && { tags: body.tags }),
          ...(body?.notes !== undefined && { notes: body.notes }),
          ...(body?.member_visible !== undefined && { memberVisible: body.member_visible }),
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

  // STR-114: archive/restore — the only removal semantics (TC-DOC-022, no
  // DELETE route anywhere on the document surface).
  new RawRoute(scope, 'archive-document', {
    method: 'POST',
    path: '/v1/documents/{documentId}/archive',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { documentId } = ctx.request.params;
      try {
        const doc = await archiveDocument(db, documentId);
        if (!doc) {
          sendNotFound(ctx, `No document ${documentId}`);
          return;
        }
        ctx.response.send(toDocumentResponse(doc));
      } catch (e) {
        if (e instanceof DocumentLifecycleConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'restore-document', {
    method: 'POST',
    path: '/v1/documents/{documentId}/restore',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const { documentId } = ctx.request.params;
      try {
        const doc = await restoreDocument(db, documentId);
        if (!doc) {
          sendNotFound(ctx, `No document ${documentId}`);
          return;
        }
        ctx.response.send(toDocumentResponse(doc));
      } catch (e) {
        if (e instanceof DocumentLifecycleConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  // STR-113: the category list's own CRUD surface — GET/PUT with
  // replace-the-whole-set semantics (the STR-057/STR-043 precedent).
  new RawRoute(scope, 'list-document-categories', {
    method: 'GET',
    path: '/v1/document-categories',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      ctx.response.send({ categories: await listCategories(db) });
    },
  });

  new RawRoute(scope, 'replace-document-categories', {
    method: 'PUT',
    path: '/v1/document-categories',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const body = await ctx.request.json();
      try {
        const categories = await replaceCategories(db, body?.categories);
        ctx.response.send({ categories });
      } catch (e) {
        if (e instanceof DocumentCategoryConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof DocumentValidationError) {
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
      if (!(await requireAuthenticated(ctx, db))) return;

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
