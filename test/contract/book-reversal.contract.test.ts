import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, type CounterpartyType, type PostingLine } from '../../aws-blocks/finance/journal';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asEmployee } from '../support/cognito-token';

// STR-026 -- `POST /v1/books/{book}/entries/{entryId}/reversal`, the one write
// the Admin contract documents against a book entry. Uses the real `db`
// singleton the registered RawRoutes read from (aws-blocks/index.ts), the
// same approach as test/contract/books.contract.test.ts, and the same
// capability-gate/Idempotency-Key case split as
// test/contract/invoice-payments.contract.test.ts.
//
// The correction rules themselves belong to STR-022 and are tested at the
// service layer in test/finance/reversal.test.ts -- these cases only assert
// what becomes observable once the function is reachable over HTTP.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/** Posts a balanced entry that is guaranteed to appear in the given book. */
async function postEntryForBook(book: 'bank' | 'cash' | 'payment' | 'expense', amount: string): Promise<string> {
  const counterparty: Pick<PostingLine, 'counterpartyType' | 'counterpartyId'> =
    book === 'payment'
      ? { counterpartyType: 'member' as CounterpartyType, counterpartyId: `member-${randomUUID()}` }
      : book === 'expense'
        ? { counterpartyType: 'vendor' as CounterpartyType, counterpartyId: `vendor-${randomUUID()}` }
        : {};
  const account = book === 'cash' ? 'cash' : 'bank';
  const { entryId } = await postJournalEntry(db, `reversal contract test ${book} ${randomUUID()}`, [
    { accountId: account, direction: 'debit', amount, ...counterparty },
    { accountId: 'cash', direction: 'credit', amount },
  ]);
  return entryId;
}

async function financeRecorderEmployeeId(): Promise<string> {
  const employee = await createEmployee(db, { name: `Reversal Contract Recorder ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

/** The headers a permitted correction carries: the capability actor plus the contract's required Idempotency-Key. */
async function correctionHeaders(): Promise<Record<string, string>> {
  return { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, await financeRecorderEmployeeId())) };
}

interface JournalLineRow {
  entry_id: string;
  account_id: string;
  direction: string;
  amount: string;
}

async function journalLinesFor(entryId: string): Promise<JournalLineRow[]> {
  const rows = await db.query<JournalLineRow>(
    sql`SELECT entry_id, account_id, direction, amount FROM journal_lines WHERE entry_id = ${entryId} ORDER BY account_id, direction`,
  );
  return rows;
}

describe('STR-026 T-C1 -- POST /v1/books/{book}/entries/{entryId}/reversal conforms to the Admin OpenAPI (covers TC-FIN-004)', () => {
  it('posts the reversing entry and returns it as an ordinary LedgerEntry linked to the original', async () => {
    const entryId = await postEntryForBook('bank', '1250.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'Amount recorded against the wrong bank account' },
      await correctionHeaders(),
    );

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/books/{book}/entries/{entryId}/reversal', 'post');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();

    const reversal = response.body as { entry_id: string; book: string; amount: string; reverses_entry_id: string | null };
    expect(reversal.reverses_entry_id).toBe(entryId);
    expect(reversal.book).toBe('bank');
    expect(reversal.amount).toBe('1250.00');
    expect(reversal.entry_id).not.toBe(entryId);
  });

  it('leaves both entries visible with a net effect of zero on every account (covers TC-FIN-004)', async () => {
    const entryId = await postEntryForBook('bank', '900.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'Duplicate posting' },
      await correctionHeaders(),
    );
    const reversalId = (response.body as { entry_id: string }).entry_id;

    // Both entries remain readable through the book-read surface — a
    // correction hides nothing.
    const originalRead = await dispatchRequest('GET', `/v1/books/bank/entries/${entryId}`, {}, await asAnyStaff(db));
    const reversalRead = await dispatchRequest('GET', `/v1/books/bank/entries/${reversalId}`, {}, await asAnyStaff(db));
    expect(originalRead.status).toBe(200);
    expect(reversalRead.status).toBe(200);
    expect((originalRead.body as { reversed_by_entry_id: string | null }).reversed_by_entry_id).toBe(reversalId);

    // Net effect zero: every account touched by the pair nets to no movement.
    // Exact decimal-string arithmetic only — amounts are compared as the
    // paise integers they are, never as floats.
    const net = new Map<string, bigint>();
    for (const line of [...(await journalLinesFor(entryId)), ...(await journalLinesFor(reversalId))]) {
      const paise = BigInt(line.amount.replace('.', ''));
      const signed = line.direction === 'debit' ? paise : -paise;
      net.set(line.account_id, (net.get(line.account_id) ?? 0n) + signed);
    }
    expect([...net.values()].every(v => v === 0n)).toBe(true);
  });
});

describe('STR-026 T-C2 -- the original entry is untouched by the correction (covers TC-FIN-003)', () => {
  it('re-reads identical postings after the correction, with no mutation and no edit timestamp', async () => {
    const entryId = await postEntryForBook('cash', '410.50');

    const before = await dispatchRequest('GET', `/v1/books/cash/entries/${entryId}`, {}, await asAnyStaff(db));
    const linesBefore = await journalLinesFor(entryId);
    const postedAtBefore = await db.queryOne<{ posted_at: string }>(
      sql`SELECT posted_at::text AS posted_at FROM journal_entries WHERE id = ${entryId}`,
    );

    const reversalResponse = await dispatchRequest(
      'POST',
      `/v1/books/cash/entries/${entryId}/reversal`,
      { reason: 'Wrong payee' },
      await correctionHeaders(),
    );
    expect(reversalResponse.status).toBe(201);

    const after = await dispatchRequest('GET', `/v1/books/cash/entries/${entryId}`, {}, await asAnyStaff(db));
    const beforeBody = before.body as Record<string, unknown>;
    const afterBody = after.body as Record<string, unknown>;

    // Every field of the entry itself is byte-identical. `reversed_by_entry_id`
    // is excluded because it is not stored on the original at all — books-api.ts
    // derives it at read time from the reversal's backward link, so its change
    // is a new row appearing, not the original being edited.
    for (const field of ['entry_id', 'book', 'entry_date', 'description', 'amount', 'direction', 'reverses_entry_id']) {
      expect(afterBody[field]).toEqual(beforeBody[field]);
    }

    // The postings themselves are unchanged, and the entry carries no
    // updated/edited timestamp to have been touched — `posted_at` is the only
    // timestamp journal_entries has, and it still reads exactly as posted.
    expect(await journalLinesFor(entryId)).toEqual(linesBefore);
    const postedAtAfter = await db.queryOne<{ posted_at: string }>(
      sql`SELECT posted_at::text AS posted_at FROM journal_entries WHERE id = ${entryId}`,
    );
    expect(postedAtAfter?.posted_at).toBe(postedAtBefore?.posted_at);
  });
});

describe('STR-026 T-C3 -- an entry cannot be corrected twice', () => {
  it('answers 409 with the documented problem shape instead of posting a second reversal', async () => {
    const entryId = await postEntryForBook('bank', '75.00');

    const first = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'First correction' },
      await correctionHeaders(),
    );
    expect(first.status).toBe(201);

    const second = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'Second correction' },
      await correctionHeaders(),
    );

    expect(second.status).toBe(409);
    const op = await contractTest('admin', '/books/{book}/entries/{entryId}/reversal', 'post');
    expect(() => op.expectValidResponse(second.status, second.body)).not.toThrow();

    // No second correction was posted: the original still has exactly one.
    const reversals = await db.query(sql`SELECT id FROM journal_entries WHERE reverses_entry_id = ${entryId}`);
    expect(reversals).toHaveLength(1);
  });
});

describe('STR-026 T-U1 -- the correction endpoint is capability-gated on finance-recorder', () => {
  // STR-045 changed what this case means. Under the header stand-in an
  // anonymous caller was an actor with no capabilities (403); now the gate
  // cannot identify the caller at all, which is 401 -- the capability
  // question is never reached. The case below, an actor holding some *other*
  // capability, is what still exercises the 403.
  it('rejects a caller with no bearer token: 401 unauthorized', async () => {
    const entryId = await postEntryForBook('bank', '60.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'Not permitted' },
      { 'Idempotency-Key': randomUUID() },
    );

    expect(response.status).toBe(401);
    expect((response.body as { error: { code: string } }).error.code).toBe('unauthorized');
    // The gate denies before anything is written.
    const reversals = await db.query(sql`SELECT id FROM journal_entries WHERE reverses_entry_id = ${entryId}`);
    expect(reversals).toHaveLength(0);
  });

  it('rejects an actor holding some other capability: 403 capability_required', async () => {
    const entryId = await postEntryForBook('bank', '61.00');
    const employee = await createEmployee(db, { name: `Reversal Contract Verifier ${randomUUID()}` });
    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'Not permitted' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employee.employee_id)) },
    );

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('capability_required');
  });
});

describe('STR-026 T-U2 -- the contract-required request fields are enforced', () => {
  it('rejects a correction with no reason: 422', async () => {
    const entryId = await postEntryForBook('bank', '64.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      {},
      await correctionHeaders(),
    );

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('rejects a correction with the capability present but no Idempotency-Key: 422', async () => {
    const entryId = await postEntryForBook('bank', '62.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${entryId}/reversal`,
      { reason: 'No key' },
      await asEmployee(db, await financeRecorderEmployeeId()),
    );

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('validation_error');
  });
});

describe('STR-026 T-U3 -- path params are validated the way the sibling book reads validate them', () => {
  it('rejects an unknown book value: 400', async () => {
    const entryId = await postEntryForBook('bank', '63.00');

    const response = await dispatchRequest(
      'POST',
      `/v1/books/foo/entries/${entryId}/reversal`,
      { reason: 'Unknown book' },
      await correctionHeaders(),
    );

    expect(response.status).toBe(400);
  });

  it('rejects an entry that does not exist in the named book: 404', async () => {
    const response = await dispatchRequest(
      'POST',
      `/v1/books/bank/entries/${randomUUID()}/reversal`,
      { reason: 'No such entry' },
      await correctionHeaders(),
    );

    expect(response.status).toBe(404);
    // Asserted on the body, not just the status: an unregistered route also
    // dispatches as a bare 404, so only the documented problem shape
    // distinguishes a real not-found answer from the endpoint not existing.
    expect((response.body as { error: { code: string } }).error.code).toBe('not_found');
  });
});
