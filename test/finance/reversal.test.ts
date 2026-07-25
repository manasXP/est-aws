import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql, DatabaseErrors, isBlocksError } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, JournalError } from '../../aws-blocks/finance/journal';
import { reverseJournalEntry } from '../../aws-blocks/finance/reversal';
import { getPaymentLedgerEntries, getExpenseLedgerEntries } from '../../aws-blocks/finance/books';
import { moneyEquals, parseMoney, formatMoney } from '../../aws-blocks/money';

// STR-022 — append-only journal immutability + reversing-entry corrections.
// Follows the STR-021 test pattern: fresh Database + Scope per test, baseline
// + finance migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-022-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-022 journal immutability — database-level guard', () => {
  // T-U1 (covers TC-FIN-003): direct SQL UPDATE/DELETE against journal_entries
  // and journal_lines are rejected at the database level (the trigger fires),
  // and the row is unchanged after the rejected attempt.
  it('rejects a direct UPDATE of a journal entry, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'original posting', [
      { accountId: 'cash', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ]);

    await expect(
      db.execute(sql`UPDATE journal_entries SET description = 'tampered' WHERE id = ${entryId}`),
    ).rejects.toThrow();

    const entry = await db.queryOne<{ description: string }>(
      sql`SELECT description FROM journal_entries WHERE id = ${entryId}`,
    );
    expect(entry!.description).toBe('original posting');
  });

  it('rejects a direct DELETE of a journal entry, leaving it in place', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'original posting', [
      { accountId: 'cash', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ]);

    await expect(db.execute(sql`DELETE FROM journal_entries WHERE id = ${entryId}`)).rejects.toThrow();

    const entry = await db.queryOne(sql`SELECT id FROM journal_entries WHERE id = ${entryId}`);
    expect(entry).not.toBeNull();
  });

  it('rejects a direct UPDATE of a journal line, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    await postJournalEntry(db, 'original posting', [
      { accountId: 'cash', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ]);
    const line = await db.queryOne<{ id: string; amount: string }>(
      sql`SELECT id, amount FROM journal_lines WHERE direction = 'debit'`,
    );

    await expect(
      db.execute(sql`UPDATE journal_lines SET amount = '999.00' WHERE id = ${line!.id}`),
    ).rejects.toThrow();

    const unchanged = await db.queryOne<{ amount: string }>(sql`SELECT amount FROM journal_lines WHERE id = ${line!.id}`);
    expect(unchanged!.amount).toBe(line!.amount);
  });

  it('rejects a direct DELETE of a journal line, leaving it in place', async () => {
    const db = await freshMigratedDb();
    await postJournalEntry(db, 'original posting', [
      { accountId: 'cash', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ]);
    const line = await db.queryOne<{ id: string }>(sql`SELECT id FROM journal_lines WHERE direction = 'debit'`);

    await expect(db.execute(sql`DELETE FROM journal_lines WHERE id = ${line!.id}`)).rejects.toThrow();

    const stillThere = await db.queryOne(sql`SELECT id FROM journal_lines WHERE id = ${line!.id}`);
    expect(stillThere).not.toBeNull();
  });
});

describe('STR-022 reverseJournalEntry — reversing-entry corrections', () => {
  // T-U2 (covers TC-FIN-004): reversing an entry produces a linked, balanced
  // mirror posting; both entries remain visible; the net effect per account
  // across both entries is zero.
  it('posts a linked mirror entry with debit/credit swapped, leaving both entries visible and net-zero', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'erroneous posting', [
      { accountId: 'cash', direction: 'debit', amount: '150.00' },
      { accountId: 'bank', direction: 'credit', amount: '150.00' },
    ]);

    const { entryId: reversalId } = await reverseJournalEntry(db, entryId, 'reversal of erroneous posting');

    const reversalEntry = await db.queryOne<{ id: string; reverses_entry_id: string | null }>(
      sql`SELECT id, reverses_entry_id FROM journal_entries WHERE id = ${reversalId}`,
    );
    expect(reversalEntry!.reverses_entry_id).toBe(entryId);

    const originalLines = await db.query<{ account_id: string; direction: string; amount: string }>(
      sql`SELECT account_id, direction, amount FROM journal_lines WHERE entry_id = ${entryId} ORDER BY account_id`,
    );
    const reversalLines = await db.query<{ account_id: string; direction: string; amount: string }>(
      sql`SELECT account_id, direction, amount FROM journal_lines WHERE entry_id = ${reversalId} ORDER BY account_id`,
    );

    expect(reversalLines).toHaveLength(originalLines.length);
    const flippedDirection = (direction: string) => (direction === 'debit' ? 'credit' : 'debit');
    expect(reversalLines).toEqual(
      originalLines.map(line => ({
        account_id: line.account_id,
        direction: flippedDirection(line.direction),
        amount: line.amount,
      })),
    );

    // both entries still visible
    const entries = await db.query<{ id: string }>(sql`SELECT id FROM journal_entries WHERE id = ANY(${[entryId, reversalId]})`);
    expect(entries).toHaveLength(2);

    // net effect per account across both entries is zero
    const byAccount = new Map<string, bigint>();
    for (const line of [...originalLines, ...reversalLines]) {
      const signed = line.direction === 'debit' ? parseMoney(line.amount) : -parseMoney(line.amount);
      byAccount.set(line.account_id, (byAccount.get(line.account_id) ?? 0n) + signed);
    }
    for (const [, net] of byAccount) {
      expect(moneyEquals(formatMoney(net < 0n ? -net : net), '0.00')).toBe(true);
    }
  });

  // Regression (code review, STR-023): reversing a counterparty-tagged
  // posting must carry the same counterparty_type/counterparty_id onto the
  // mirror line, or the reversal silently vanishes from the Payment/Expense
  // Ledger even though the underlying journal is balanced.
  it('reversing a member-tagged posting keeps both lines in the Payment Ledger, netting to zero', async () => {
    const db = await freshMigratedDb();
    const memberId = 'member-1';
    const { entryId } = await postJournalEntry(db, 'member maintenance payment', [
      { accountId: 'bank', direction: 'debit', amount: '5000.00', counterpartyType: 'member', counterpartyId: memberId },
      { accountId: 'cash', direction: 'credit', amount: '5000.00' },
    ]);

    const { entryId: reversalId } = await reverseJournalEntry(db, entryId, 'reversal of member payment');

    const paymentLedger = await getPaymentLedgerEntries(db, memberId);
    expect(paymentLedger.some(e => e.entry_id === entryId)).toBe(true);
    expect(paymentLedger.some(e => e.entry_id === reversalId)).toBe(true);

    const net = paymentLedger.reduce(
      (total, line) => total + (line.direction === 'debit' ? parseMoney(line.amount) : -parseMoney(line.amount)),
      0n,
    );
    expect(moneyEquals(formatMoney(net < 0n ? -net : net), '0.00')).toBe(true);
  });

  it('reversing a vendor-tagged posting keeps both lines in the Expense Ledger, netting to zero', async () => {
    const db = await freshMigratedDb();
    const vendorId = 'vendor-1';
    const { entryId } = await postJournalEntry(db, 'vendor invoice payment', [
      { accountId: 'bank', direction: 'credit', amount: '1500.00', counterpartyType: 'vendor', counterpartyId: vendorId },
      { accountId: 'cash', direction: 'debit', amount: '1500.00' },
    ]);

    const { entryId: reversalId } = await reverseJournalEntry(db, entryId, 'reversal of vendor payment');

    const expenseLedger = await getExpenseLedgerEntries(db, vendorId);
    expect(expenseLedger.some(e => e.entry_id === entryId)).toBe(true);
    expect(expenseLedger.some(e => e.entry_id === reversalId)).toBe(true);

    const net = expenseLedger.reduce(
      (total, line) => total + (line.direction === 'debit' ? parseMoney(line.amount) : -parseMoney(line.amount)),
      0n,
    );
    expect(moneyEquals(formatMoney(net < 0n ? -net : net), '0.00')).toBe(true);
  });

  it('rejects reversing an entry that does not exist', async () => {
    const db = await freshMigratedDb();

    await expect(reverseJournalEntry(db, 'no-such-entry', 'reversal')).rejects.toThrow(JournalError);
  });

  // T-U3: reversing an already-reversed entry is rejected, with nothing written.
  it('rejects reversing an already-reversed entry, writing no second reversal', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'erroneous posting', [
      { accountId: 'cash', direction: 'debit', amount: '75.00' },
      { accountId: 'bank', direction: 'credit', amount: '75.00' },
    ]);
    await reverseJournalEntry(db, entryId, 'first reversal');

    await expect(reverseJournalEntry(db, entryId, 'second reversal')).rejects.toThrow(JournalError);

    const reversals = await db.query(sql`SELECT id FROM journal_entries WHERE reverses_entry_id = ${entryId}`);
    expect(reversals).toHaveLength(1);
  });

  // Regression for the TOCTOU race in reverseJournalEntry's app-level
  // "already reversed" check (SELECT ... WHERE reverses_entry_id = ...
  // outside any transaction): two concurrent callers could both pass that
  // check before either commits its INSERT. migrations/003_reversal_uniqueness.sql
  // backstops this with a partial unique index on journal_entries
  // (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL, so the second
  // INSERT fails at the database level even when the app-level check is
  // bypassed entirely — simulated here by calling postJournalEntry directly
  // twice, as two callers who both already passed the SELECT check would.
  it('rejects a second direct postJournalEntry reversing the same entry, even bypassing the app-level check', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'erroneous posting', [
      { accountId: 'cash', direction: 'debit', amount: '50.00' },
      { accountId: 'bank', direction: 'credit', amount: '50.00' },
    ]);

    await postJournalEntry(db, 'first reversal', [
      { accountId: 'cash', direction: 'credit', amount: '50.00' },
      { accountId: 'bank', direction: 'debit', amount: '50.00' },
    ], { reversesEntryId: entryId });

    await expect(
      postJournalEntry(db, 'second reversal', [
        { accountId: 'cash', direction: 'credit', amount: '50.00' },
        { accountId: 'bank', direction: 'debit', amount: '50.00' },
      ], { reversesEntryId: entryId }),
    ).rejects.toSatisfy((e: unknown) => isBlocksError(e, DatabaseErrors.UniqueConstraintViolation));

    const reversals = await db.query(sql`SELECT id FROM journal_entries WHERE reverses_entry_id = ${entryId}`);
    expect(reversals).toHaveLength(1);
  });
});
