// STR-116: the mobile Public API's PC document read surface --
// `GET /v1/pc/projects/{projectId}/documents` and
// `GET /v1/pc/documents/{documentId}/download`, served through RawRoute.
// The read-only exception to v1's admin-panel-only document access
// (Document Management spec, Access): PC members read ALL of their
// project's documents -- member_visible does not gate PC reads. Follows
// aws-blocks/assets/pc-assets-routes.ts unchanged: X-Actor-Member-Id stub
// header, isPcMember (STR-057) for the gate, thin delegation to
// documents-api.ts for the reads.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import { listDocuments, getDocument, getDownloadUrl, DOWNLOAD_URL_EXPIRES_IN_SECONDS } from './documents-api';
import type { DocumentRecord } from './documents-api';
import { isPcMember } from '../assets/asset-visibility';
import { getProject } from '../projects/projects-api';
import { sendCapabilityRequired, sendNotFound } from '../http/problem-response';

/** Whether `memberId` sits on the PC of `doc`'s own project — the STR-116
 * download gate, extracted per the story's Refactor step so E14's project
 * bulletin-post attachments can reuse it. False for non-project documents. */
export async function isPcMemberOfDocument(db: Database, doc: DocumentRecord, memberId: string): Promise<boolean> {
  if (doc.level !== 'project' || !doc.projectId) return false;
  return isPcMember(db, doc.projectId, memberId);
}

// The mobile PcDocument schema: no file_key/checksum/status/uploaded_by
// leakage; size_bytes omitted while still null (same convention as the
// admin Document response).
function toPcDocumentResponse(doc: DocumentRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    document_id: doc.documentId,
    title: doc.title,
    category: doc.category,
    tags: doc.tags,
    notes: doc.notes,
    file_name: doc.fileName,
    mime_type: doc.mimeType,
    uploaded_at: doc.uploadedAt,
    member_visible: doc.memberVisible,
  };
  if (doc.sizeBytes !== null) {
    body.size_bytes = doc.sizeBytes;
  }
  return body;
}

export function registerPcDocumentRoutes(scope: Scope, db: Database, bucket: FileBucket): void {
  new RawRoute(scope, 'list-pc-project-documents', {
    method: 'GET',
    path: '/v1/pc/projects/{projectId}/documents',
    handler: async ctx => {
      const { projectId } = ctx.request.params;
      const project = await getProject(db, projectId);
      if (!project) {
        sendNotFound(ctx, `No project ${projectId}`);
        return;
      }

      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId || !(await isPcMember(db, projectId, memberId))) {
        sendCapabilityRequired(ctx, 'pc-member');
        return;
      }

      const params = ctx.request.url.searchParams;
      const items = await listDocuments(db, {
        level: 'project',
        projectId,
        // `|| undefined` for q, not `??`: ?q= must mean "no filter"
        // (the STR-115 empty-tsquery fix, same reasoning).
        q: params.get('q') || undefined,
        category: params.get('category') ?? undefined,
      });
      ctx.response.send({ items: items.map(toPcDocumentResponse), next_cursor: null });
    },
  });

  new RawRoute(scope, 'download-pc-document', {
    method: 'GET',
    path: '/v1/pc/documents/{documentId}/download',
    handler: async ctx => {
      const { documentId } = ctx.request.params;
      const doc = await getDocument(db, bucket, documentId);
      // Archived documents 404 like nonexistent ones: this surface neither
      // lists them (T-U3) nor confirms what it does not list.
      if (!doc || doc.status === 'archived') {
        sendNotFound(ctx, `No document ${documentId}`);
        return;
      }

      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId || !(await isPcMemberOfDocument(db, doc, memberId))) {
        sendCapabilityRequired(ctx, 'pc-member');
        return;
      }

      const url = await getDownloadUrl(db, bucket, documentId);
      if (!url) {
        sendNotFound(ctx, `No document ${documentId}`);
        return;
      }
      const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();
      ctx.response.send({ url, expires_at: expiresAt });
    },
  });
}
