import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, type CounterpartyType, type PostingLine } from '../../aws-blocks/finance/journal';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-024 — Admin API book-read surface, contract cases. Uses the real `db`
// singleton the registered RawRoutes read from (aws-blocks/index.ts), the
// same approach as test/contract/health.contract.test.ts: dispatch the real
// handler, feed its response through the harness. Unlike STR-023's
// books.test.ts (fresh per-test Database), the journal is append-only, so
// this migrates the singleton `db` once and posts entries scoped narrowly
// enough (specific ids, specific amounts) not to collide with other rows
// that may already exist in it.

const BOOKS = ['bank', 'cash', 'payment', 'expense'] as const;

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/** Posts a balanced entry that is guaranteed to appear in the given book. */
async function postEntryForBook(book: (typeof BOOKS)[number], amount: string): Promise<string> {
  const counterparty: Pick<PostingLine, 'counterpartyType' | 'counterpartyId'> =
    book === 'payment'
      ? { counterpartyType: 'member' as CounterpartyType, counterpartyId: `member-${randomUUID()}` }
      : book === 'expense'
        ? { counterpartyType: 'vendor' as CounterpartyType, counterpartyId: `vendor-${randomUUID()}` }
        : {};
  const account = book === 'cash' ? 'cash' : 'bank';
  const { entryId } = await postJournalEntry(db, `contract test ${book} ${randomUUID()}`, [
    { accountId: account, direction: 'debit', amount, ...counterparty },
    { accountId: 'cash', direction: 'credit', amount },
  ]);
  return entryId;
}

describe('STR-024 T-C1 — admin book-read API contract', () => {
  it.each(BOOKS)('GET /v1/books/%s/entries conforms to the Admin OpenAPI', async book => {
    await postEntryForBook(book, '10.00');
    const response = await dispatchRequest('GET', `/v1/books/${book}/entries`);

    const op = await contractTest('admin', '/books/{book}/entries', 'get');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it.each(BOOKS)('GET /v1/books/%s/entries/{entryId} for a real posted entry conforms to the Admin OpenAPI', async book => {
    const entryId = await postEntryForBook(book, '10.00');
    const response = await dispatchRequest('GET', `/v1/books/${book}/entries/${entryId}`);

    const op = await contractTest('admin', '/books/{book}/entries/{entryId}', 'get');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('rejects an unknown book value before hitting the DB', async () => {
    const response = await dispatchRequest('GET', '/v1/books/foo/entries');
    expect(response.status).toBe(400);
  });
});

describe('STR-024 T-C2 — money fields are decimal strings exactly as posted (TC-FIN-009 at the API boundary)', () => {
  it('returns the posted amount as a byte-exact decimal string, both in the list and the detail read', async () => {
    const entryId = await postEntryForBook('bank', '1250.00');

    const listResponse = await dispatchRequest('GET', '/v1/books/bank/entries');
    const listed = (listResponse.body as { items: { entry_id: string; amount: string }[] }).items.find(
      e => e.entry_id === entryId,
    );
    expect(listed?.amount).toBe('1250.00');

    const detailResponse = await dispatchRequest('GET', `/v1/books/bank/entries/${entryId}`);
    expect((detailResponse.body as { amount: string }).amount).toBe('1250.00');
  });
});
