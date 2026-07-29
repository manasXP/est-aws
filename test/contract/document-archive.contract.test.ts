import { describe, it, expect } from 'vitest';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asNewEmployee } from '../support/cognito-token';

// STR-114 T-C1 (BE-C) — POST /v1/documents/{documentId}/archive and
// /restore against the Admin OpenAPI's Document and Error schemas,
// following the same real-handler dispatchRequest template as the
// STR-111/112/113 suites. Each case registers its own fresh document (with
// the file landed so the 200 Document body carries a verified checksum),
// so nothing leaks between cases or runs in the shared .bb-data store.

async function registeredDocumentId(): Promise<string> {
  const registerResponse = await dispatchRequest('POST', '/v1/documents', {
    level: 'society',
    title: 'Society Bye-laws',
    category: 'Bye-laws',
    filename: 'byelaws.pdf',
    content_type: 'application/pdf',
  }, { ...(await asNewEmployee(db)) });
  const documentId = (registerResponse.body as { document_id: string }).document_id;
  const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
  await documents.put(row!.file_key, 'byelaws contents', { contentType: 'application/pdf' });
  return documentId;
}

describe('STR-114 T-C1 — document archive/restore endpoint contract', () => {
  it('POST .../archive conforms to the declared 200 Document response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('POST', `/v1/documents/${documentId}/archive`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/documents/{documentId}/archive', 'post');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ document_id: documentId, status: 'archived' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST .../archive on an already-archived document conforms to the declared 409 Error shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();
    await dispatchRequest('POST', `/v1/documents/${documentId}/archive`, {}, await asAnyStaff(db));

    const response = await dispatchRequest('POST', `/v1/documents/${documentId}/archive`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/documents/{documentId}/archive', 'post');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST .../restore conforms to the declared 200 Document response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();
    await dispatchRequest('POST', `/v1/documents/${documentId}/archive`, {}, await asAnyStaff(db));

    const response = await dispatchRequest('POST', `/v1/documents/${documentId}/restore`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/documents/{documentId}/restore', 'post');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ document_id: documentId, status: 'active' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST .../restore on a document that is not archived conforms to the declared 409 Error shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('POST', `/v1/documents/${documentId}/restore`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/documents/{documentId}/restore', 'post');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST .../archive and .../restore on a nonexistent document conform to the declared 404 shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const archive404 = await dispatchRequest('POST', '/v1/documents/no-such-document/archive', {}, await asAnyStaff(db));
    const archiveOp = await contractTest('admin', '/documents/{documentId}/archive', 'post');
    expect(archive404.status).toBe(404);
    expect(() => archiveOp.expectValidResponse(archive404.status, archive404.body)).not.toThrow();

    const restore404 = await dispatchRequest('POST', '/v1/documents/no-such-document/restore', {}, await asAnyStaff(db));
    const restoreOp = await contractTest('admin', '/documents/{documentId}/restore', 'post');
    expect(restore404.status).toBe(404);
    expect(() => restoreOp.expectValidResponse(restore404.status, restore404.body)).not.toThrow();
  });
});
