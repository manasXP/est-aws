import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import {
  getBankBookEntries,
  getCashBookEntries,
  getPaymentLedgerEntries,
  getExpenseLedgerEntries,
} from '../../aws-blocks/finance/books';

// STR-023 — book-projection classification, unit cases. Follows the
// STR-021/STR-022 test pattern: fresh Database + Scope per test, baseline +
// finance migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-023-test-${randomUUID()}`), 'db');
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

describe('STR-023 book projections — Bank/Cash Book and Payment/Expense Ledger', () => {
  // T-U1 (covers TC-FIN-005): a member payment received into the bank
  // account, posted once, appears in the Bank Book view AND that member's
  // Payment Ledger view — one posting, both projections.
  it('a member payment into bank appears in the Bank Book and the member Payment Ledger', async () => {
    const db = await freshMigratedDb();
    const memberId = 'member-1';
    const { entryId } = await postJournalEntry(db, 'member maintenance payment', [
      { accountId: 'bank', direction: 'debit', amount: '5000.00', counterpartyType: 'member', counterpartyId: memberId },
      { accountId: 'cash', direction: 'credit', amount: '5000.00' },
    ]);

    const bankBook = await getBankBookEntries(db);
    expect(bankBook.some(e => e.entry_id === entryId && e.counterparty_id === memberId)).toBe(true);

    const paymentLedger = await getPaymentLedgerEntries(db, memberId);
    expect(paymentLedger.some(e => e.entry_id === entryId)).toBe(true);
  });

  // T-U2 (covers TC-FIN-006): a cash receipt appears in the Cash Book view
  // and not in the Bank Book view.
  it('a cash receipt appears in the Cash Book and not the Bank Book', async () => {
    const db = await freshMigratedDb();
    const { entryId } = await postJournalEntry(db, 'cash receipt', [
      { accountId: 'cash', direction: 'debit', amount: '200.00' },
      { accountId: 'cash', direction: 'credit', amount: '200.00' },
    ]);

    const cashBook = await getCashBookEntries(db);
    expect(cashBook.some(e => e.entry_id === entryId)).toBe(true);

    const bankBook = await getBankBookEntries(db);
    expect(bankBook.some(e => e.entry_id === entryId)).toBe(false);
  });

  // T-U3 (covers TC-FIN-007): a vendor invoice payment from bank appears in
  // the Expense Ledger (vendor counterparty) and the Bank Book.
  it('a vendor invoice payment from bank appears in the Expense Ledger and the Bank Book', async () => {
    const db = await freshMigratedDb();
    const vendorId = 'vendor-1';
    const { entryId } = await postJournalEntry(db, 'vendor invoice payment', [
      { accountId: 'bank', direction: 'credit', amount: '1500.00', counterpartyType: 'vendor', counterpartyId: vendorId },
      { accountId: 'cash', direction: 'debit', amount: '1500.00' },
    ]);

    const expenseLedger = await getExpenseLedgerEntries(db, vendorId);
    expect(expenseLedger.some(e => e.entry_id === entryId)).toBe(true);

    const bankBook = await getBankBookEntries(db);
    expect(bankBook.some(e => e.entry_id === entryId)).toBe(true);
  });

  // T-U4 (genuine-gap ID, employee salary): a line tagged
  // counterparty_type='payee' (an employee) appears in the Expense Ledger
  // under that payee.
  it('an employee salary payment appears in the Expense Ledger under the payee', async () => {
    const db = await freshMigratedDb();
    const payeeId = 'employee-1';
    const { entryId } = await postJournalEntry(db, 'employee salary payment', [
      { accountId: 'bank', direction: 'credit', amount: '30000.00', counterpartyType: 'payee', counterpartyId: payeeId },
      { accountId: 'cash', direction: 'debit', amount: '30000.00' },
    ]);

    const expenseLedger = await getExpenseLedgerEntries(db, payeeId);
    expect(expenseLedger.some(e => e.entry_id === entryId)).toBe(true);
  });
});
