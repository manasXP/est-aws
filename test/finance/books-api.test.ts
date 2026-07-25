import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { reverseJournalEntry } from '../../aws-blocks/finance/reversal';
import { financialYearOf } from '../../aws-blocks/finance/financial-year';
import { listBookEntries } from '../../aws-blocks/finance/books-api';

// STR-024 — Admin API book-read business logic, unit cases. Follows the
// STR-023 test pattern (test/finance/books.test.ts): fresh Database + Scope
// per test, baseline + finance migrations applied via MIGRATIONS_DIR. These
// exercise the underlying listBookEntries/financialYearOf logic directly,
// not the HTTP layer (that's test/contract/books.contract.test.ts).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-024-test-${randomUUID()}`), 'db');
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

describe('STR-024 T-U1 — Indian financial year period filtering', () => {
  it('resolves the Apr-1 boundary into the correct financial year', () => {
    expect(financialYearOf('2026-03-31')).toEqual({ start: '2025-04-01', end: '2026-03-31', label: '2025-26' });
    expect(financialYearOf('2026-04-01')).toEqual({ start: '2026-04-01', end: '2027-03-31', label: '2026-27' });
  });

  it('only returns entries inside the requested FY window', async () => {
    const db = await freshMigratedDb();
    const { entryId: fy2526EntryId } = await postJournalEntry(
      db,
      'FY 2025-26 entry',
      [
        { accountId: 'bank', direction: 'debit', amount: '100.00' },
        { accountId: 'cash', direction: 'credit', amount: '100.00' },
      ],
      { postedAt: '2026-03-31' },
    );
    const { entryId: fy2627EntryId } = await postJournalEntry(
      db,
      'FY 2026-27 entry',
      [
        { accountId: 'bank', direction: 'debit', amount: '200.00' },
        { accountId: 'cash', direction: 'credit', amount: '200.00' },
      ],
      { postedAt: '2026-04-01' },
    );

    const fy2526 = financialYearOf('2026-03-31');
    const itemsFy2526 = await listBookEntries(db, 'bank', { from: fy2526.start, to: fy2526.end });
    expect(itemsFy2526.some(e => e.entry_id === fy2526EntryId)).toBe(true);
    expect(itemsFy2526.some(e => e.entry_id === fy2627EntryId)).toBe(false);

    const fy2627 = financialYearOf('2026-04-01');
    const itemsFy2627 = await listBookEntries(db, 'bank', { from: fy2627.start, to: fy2627.end });
    expect(itemsFy2627.some(e => e.entry_id === fy2627EntryId)).toBe(true);
    expect(itemsFy2627.some(e => e.entry_id === fy2526EntryId)).toBe(false);
  });
});

describe('STR-024 T-U2 — reversal linkage visible in book reads', () => {
  it('shows both the original and its reversal, each flagged with the link to the other', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'original posting', [
      { accountId: 'bank', direction: 'debit', amount: '50.00' },
      { accountId: 'cash', direction: 'credit', amount: '50.00' },
    ]);
    const { entryId: reversalId } = await reverseJournalEntry(db, entryId, 'correction of original posting');

    const items = await listBookEntries(db, 'bank', {});
    const original = items.find(e => e.entry_id === entryId);
    const reversal = items.find(e => e.entry_id === reversalId);

    expect(original).toBeDefined();
    expect(reversal).toBeDefined();
    expect(original!.reverses_entry_id).toBeNull();
    expect(original!.reversed_by_entry_id).toBe(reversalId);
    expect(reversal!.reverses_entry_id).toBe(entryId);
    expect(reversal!.reversed_by_entry_id).toBeNull();
  });
});
