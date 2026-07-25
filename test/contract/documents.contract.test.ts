import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
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
// registry, not this story. The 201 success response below is therefore
// checked directly rather than against the full DocumentLink schema; the
// 404 paths (which use the registry-agnostic Error schema) are fully
// schema-validated.

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
    expect(response.body).toMatchObject({ document_id: documentPath });
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
