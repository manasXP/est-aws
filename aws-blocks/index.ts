import { Scope, Database, FileBucket, RawRoute } from '@aws-blocks/blocks';
import { SCOPE_ID, DB_BLOCK_ID, DOCUMENTS_BLOCK_ID } from './block-ids';
import { linkDocumentToEntry, DocumentLinkError } from './finance/documents';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

// Estatly deploys one stack per society — single scope, no tenancy machinery,
// no society_id anywhere. The society is a deployment concern (EST-Deploy).
const scope = new Scope(SCOPE_ID);

// The two stateful Blocks, fixed from commit one (IDs are immutable — see
// block-ids.ts). Other mapped Blocks (AuthCognito, CronJob, AsyncJob,
// EmailClient, AppSetting, Logger/Metrics/Dashboard) join when their consuming
// stories arrive — no speculative declarations.
export const db = new Database(scope, DB_BLOCK_ID);
export const documents = new FileBucket(scope, DOCUMENTS_BLOCK_ID);

// STR-005: the walking-skeleton endpoint — proves the full delivery loop
// (contract, handler, tests, CI) before any domain story starts. Served
// through RawRoute, the STR-003-decided mechanism for the Admin/Mobile REST
// surfaces. Matches the mobile OpenAPI's GET /health (est-spec).
new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/v1/health',
  handler: async (ctx) => {
    ctx.response.send({ status: 'ok' });
  }
});

// STR-025: link a scanned document (identified by its FileBucket path — the
// full document registry is E12, M3, not yet built) to a ledger entry.
// `book` is accepted for URL shape parity with the other /v1/books/{book}
// endpoints (not yet built) but isn't otherwise consulted — the link itself
// only depends on the entry.
new RawRoute(scope, 'link-book-entry-document', {
  method: 'POST',
  path: '/v1/books/{book}/entries/{entryId}/documents',
  handler: async (ctx) => {
    const { entryId } = ctx.request.params;
    const body = await ctx.request.json();
    const documentId: string = body?.document_id ?? '';
    try {
      const link = await linkDocumentToEntry(db, documents, entryId, documentId);
      ctx.response.status = 201;
      ctx.response.send({
        document_id: link.documentId,
        file_name: link.fileName,
        linked_at: link.linkedAt,
      });
    } catch (e: unknown) {
      if (e instanceof DocumentLinkError) {
        ctx.response.status = e.code === 'already_linked' ? 409 : 404;
        ctx.response.send({ error: { code: e.code, message: e.message } });
        return;
      }
      throw e;
    }
  }
});
