import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-025 T-C1 — POST /v1/books/{book}/entries/{entryId}/documents against
// the Admin OpenAPI, following STR-005's real-handler contract-test
// template. Runs against the singleton `db`/`documents` blocks exported by
// aws-blocks/index.ts (same blocks the real RawRoute handler uses), so
// migrations are applied once up front like STR-014's management-actions
// tests do for the same singleton.
//
// Known, recorded gap (see aws-blocks/finance/documents.ts and this story's
// PR): the Admin OpenAPI's DocumentLink schema requires `title`/`category`,
// which only a document *registry* can supply — E12 (M3) builds that
// registry, not this story. `contractTest()` below still proves POST
// .../documents is a declared admin-surface operation (it throws otherwise),
// but the 201 success response's *body* is checked directly against every
// field the real handler returns rather than the full DocumentLink schema
// (which `op.expectValidResponse` would fail on the missing title/category).
// The 404 paths (which use the registry-agnostic Error schema) are fully
// schema-validated via `op.expectValidResponse`.

async function linkedEntryId(): Promise<string> {
  const { entryId } = await postJournalEntry(db, 'STR-025 contract fixture', [
    { accountId: 'cash', direction: 'debit', amount: '10.00' },
    { accountId: 'bank', direction: 'credit', amount: '10.00' },
  ]);
  return entryId;
}

describe('STR-025 T-C1 — link-document-to-entry endpoint contract', () => {
  it("the real handler's success response conforms to what the Admin OpenAPI can honestly validate without a document registry", async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const entryId = await linkedEntryId();
    const documentPath = `vouchers/${randomUUID()}.pdf`;
    await documents.put(documentPath, 'voucher bytes', { contentType: 'application/pdf' });

    const response = await dispatchRequest('POST', `/v1/books/cash/entries/${entryId}/documents`, {
      document_id: documentPath,
    });

    await contractTest('admin', '/books/{book}/entries/{entryId}/documents', 'post');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      document_id: documentPath,
      file_name: expect.any(String),
      linked_at: expect.any(String),
    });
  });

  it('linking to a nonexistent entry fails 404 per the contract', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentPath = `vouchers/${randomUUID()}.pdf`;
    await documents.put(documentPath, 'voucher bytes');

    const response = await dispatchRequest('POST', '/v1/books/cash/entries/no-such-entry/documents', {
      document_id: documentPath,
    });

    const op = await contractTest('admin', '/books/{book}/entries/{entryId}/documents', 'post');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('linking a nonexistent document fails 404 per the contract', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const entryId = await linkedEntryId();

    const response = await dispatchRequest('POST', `/v1/books/cash/entries/${entryId}/documents`, {
      document_id: 'vouchers/does-not-exist.pdf',
    });

    const op = await contractTest('admin', '/books/{book}/entries/{entryId}/documents', 'post');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

// STR-111 T-C1 (BE-C) — the document registry's POST /v1/documents,
// GET /v1/documents/{documentId}, and GET /v1/documents/{documentId}/download
// against the Admin OpenAPI's real (non-gapped) schemas, following the same
// real-handler dispatchRequest template as the STR-025 suite above.
describe('STR-111 T-C1 — document registration and read endpoints contract', () => {
  it('POST /v1/documents conforms to the declared 201 response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents', 'post');
    expect(response.status).toBe(201);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/documents with an unknown category conforms to the declared 422 response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Bad',
      category: 'Not A Real Category',
      filename: 'f.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents', 'post');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /v1/documents/{documentId} conforms to the schema with size_bytes omitted and checksum null before any file lands', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const registerResponse = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });
    const documentId = (registerResponse.body as { document_id: string }).document_id;

    const response = await dispatchRequest('GET', `/v1/documents/${documentId}`);

    const op = await contractTest('admin', '/documents/{documentId}', 'get');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ checksum: null });
    expect(response.body).not.toHaveProperty('size_bytes');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /v1/documents/{documentId}/download conforms to the declared shapes (200 once uploaded, 404 before)', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const registerResponse = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });
    const documentId = (registerResponse.body as { document_id: string }).document_id;

    const op = await contractTest('admin', '/documents/{documentId}/download', 'get');

    const before404 = await dispatchRequest('GET', `/v1/documents/${documentId}/download`);
    expect(before404.status).toBe(404);
    expect(() => op.expectValidResponse(before404.status, before404.body)).not.toThrow();

    const fileKeyRow = await db.queryOne<{ file_key: string }>(
      sql`SELECT file_key FROM documents WHERE id = ${documentId}`,
    );
    await documents.put(fileKeyRow!.file_key, 'byelaws contents', { contentType: 'application/pdf' });

    const after200 = await dispatchRequest('GET', `/v1/documents/${documentId}/download`);
    expect(after200.status).toBe(200);
    expect(() => op.expectValidResponse(after200.status, after200.body)).not.toThrow();
  });
});

// STR-112 T-C1 (BE-C) — PATCH /v1/documents/{documentId} against the Admin
// OpenAPI's DocumentPatch/Document schemas, following the same real-handler
// dispatchRequest template as the STR-111 suite above. `member_visible` is
// in DocumentPatch but mutating it is STR-115's deliverable — this story
// must silently drop it (Definition of Done: no PATCH field beyond
// title/category/tags/notes is writable).
describe('STR-112 T-C1 — document metadata edit endpoint contract', () => {
  async function registeredDocumentId(): Promise<string> {
    const registerResponse = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-1' });
    return (registerResponse.body as { document_id: string }).document_id;
  }

  it('PATCH /v1/documents/{documentId} conforms to the declared 200 Document response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, {
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents/{documentId}', 'patch');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PATCH on a nonexistent documentId conforms to the declared 404 response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('PATCH', '/v1/documents/no-such-document', {
      title: 'Anything',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents/{documentId}', 'patch');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PATCH with an unknown category conforms to the declared 422 unknown_category response shape', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, {
      category: 'Not A Real Category',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents/{documentId}', 'patch');
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'unknown_category' } });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PATCH with an empty title conforms to the declared 422 response shape — parity with registration', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, {
      title: '',
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    const op = await contractTest('admin', '/documents/{documentId}', 'patch');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  // STR-112 originally pinned member_visible as silently dropped; STR-115
  // made it writable (TC-DOC-041), so the pin inverted. The full
  // writable-flag contract case lives in document-search.contract.test.ts.
  it('PATCH with member_visible applies the flag — writable since STR-115', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, {
      title: 'Still just a metadata edit',
      member_visible: true,
    }, { 'X-Actor-Employee-Id': 'emp-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ member_visible: true });

    const row = await db.queryOne<{ member_visible: boolean }>(
      sql`SELECT member_visible FROM documents WHERE id = ${documentId}`,
    );
    expect(row!.member_visible).toBe(true);
  });

  it('rejects with 401 when no X-Actor-* header is present', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);
    const documentId = await registeredDocumentId();

    const response = await dispatchRequest('PATCH', `/v1/documents/${documentId}`, { title: 'Anything' });

    expect(response.status).toBe(401);
  });
});

// STR-111 review fix (Bug 1) — uploaded_by must come from the resolved
// caller actor (X-Actor-Employee-Id/X-Actor-Member-Id), never the literal
// 'unknown' the OpenAPI DocumentInput schema has no field for.
describe('STR-111 review fix (Bug 1) — POST /v1/documents resolves uploaded_by from the caller actor', () => {
  it('rejects with 401 when no X-Actor-* header is present', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    });

    expect(response.status).toBe(401);
  });

  it('persists the resolved employee actor as uploaded_by, not "unknown"', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Employee-Id': 'emp-42' });
    expect(response.status).toBe(201);
    const documentId = (response.body as { document_id: string }).document_id;

    const row = await db.queryOne<{ uploaded_by: string }>(sql`SELECT uploaded_by FROM documents WHERE id = ${documentId}`);
    expect(row!.uploaded_by).toBe('emp-42');
  });

  it('persists the resolved member actor as uploaded_by when only X-Actor-Member-Id is present', async () => {
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const response = await dispatchRequest('POST', '/v1/documents', {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      content_type: 'application/pdf',
    }, { 'X-Actor-Member-Id': 'mem-7' });
    expect(response.status).toBe(201);
    const documentId = (response.body as { document_id: string }).document_id;

    const row = await db.queryOne<{ uploaded_by: string }>(sql`SELECT uploaded_by FROM documents WHERE id = ${documentId}`);
    expect(row!.uploaded_by).toBe('mem-7');
  });
});
