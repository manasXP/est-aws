import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, type CounterpartyType, type PostingLine } from '../../aws-blocks/finance/journal';
import { formatMoney } from '../../aws-blocks/money';
import {
  getBankBookEntries,
  getCashBookEntries,
  getPaymentLedgerEntries,
  getExpenseLedgerEntries,
} from '../../aws-blocks/finance/books';
import { mulberry32, splitPaise } from './prng';

// STR-023 — T-P1 (BE-P, covers TC-FIN-008): for any generated sequence of
// balanced postings mixing bank/cash accounts and member/vendor/payee/no
// counterparty tags, the union over all four book views reconciles with the
// journal — no line invisible to every book, none double-projected within
// the same book. Follows STR-021's hand-rolled seeded-PRNG pattern
// (mulberry32, shared with journal.property.test.ts via ./prng) — no
// property-testing library is installed in this repo.

const ACCOUNTS = ['cash', 'bank'];
const COUNTERPARTY_TYPES: readonly (CounterpartyType | null)[] = ['member', 'vendor', 'payee', null];

/** Randomly tags a line with a counterparty (or none), per STR-023's classification axes. */
function pickCounterparty(rand: () => number): Pick<PostingLine, 'counterpartyType' | 'counterpartyId'> {
  const type = COUNTERPARTY_TYPES[Math.floor(rand() * COUNTERPARTY_TYPES.length)];
  if (type === null) return {};
  return { counterpartyType: type, counterpartyId: `${type}-${Math.floor(rand() * 5)}` };
}

/** A balanced posting (debits == credits) mixing bank/cash accounts and counterparty tags. */
function generateBalancedPosting(rand: () => number): PostingLine[] {
  const totalPaise = BigInt(1 + Math.floor(rand() * 5000)); // 0.01 .. 50.00
  const debitParts = 1 + Math.floor(rand() * 2); // 1 or 2 lines
  const creditParts = 1 + Math.floor(rand() * 2);
  const debitAmounts = splitPaise(totalPaise, debitParts, rand);
  const creditAmounts = splitPaise(totalPaise, creditParts, rand);

  const lines: PostingLine[] = [
    ...debitAmounts.map(paise => ({
      accountId: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)],
      direction: 'debit' as const,
      amount: formatMoney(paise),
      ...pickCounterparty(rand),
    })),
    ...creditAmounts.map(paise => ({
      accountId: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)],
      direction: 'credit' as const,
      amount: formatMoney(paise),
      ...pickCounterparty(rand),
    })),
  ];

  return lines;
}

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-023 property: book-projection reconciliation (TC-FIN-008)', () => {
  it('every journal line lands in at least one book view, and none is double-projected within a book', async () => {
    const db = new Database(new Scope(`str-023-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const rand = mulberry32(20260721);
    const POSTING_COUNT = 40;

    for (let i = 0; i < POSTING_COUNT; i++) {
      const lines = generateBalancedPosting(rand);
      await postJournalEntry(db, `property posting ${i}`, lines);
    }

    const allLines = await db.query<{ id: string }>(sql`SELECT id FROM journal_lines`);
    expect(allLines.length).toBeGreaterThan(0);
    const allLineIds = new Set(allLines.map(l => l.id));

    const bankBook = await getBankBookEntries(db);
    const cashBook = await getCashBookEntries(db);
    const paymentLedger = await getPaymentLedgerEntries(db);
    const expenseLedger = await getExpenseLedgerEntries(db);

    // None double-projected within the same book view's result set.
    for (const book of [bankBook, cashBook, paymentLedger, expenseLedger]) {
      const lineIds = book.map(e => e.line_id);
      expect(new Set(lineIds).size).toBe(lineIds.length);
    }

    // No posting invisible to every book: every journal line appears in at
    // least one of the four views. Every seeded account is bank-or-cash, so
    // every line is guaranteed to land in Bank or Cash Book by construction
    // — this is really catching a query bug that drops or duplicates rows.
    const covered = new Set([...bankBook, ...cashBook, ...paymentLedger, ...expenseLedger].map(e => e.line_id));
    for (const id of allLineIds) {
      expect(covered.has(id)).toBe(true);
    }
  });
});
