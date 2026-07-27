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
    });

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
    });

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
    });
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
    });
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
