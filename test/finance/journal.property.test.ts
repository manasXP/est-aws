import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, JournalError } from '../../aws-blocks/finance/journal';
import { formatMoney, moneyEquals, parseMoney } from '../../aws-blocks/money';
import { mulberry32, generatePosting } from './prng';

// STR-021 — T-P1 (BE-P, covers TC-FIN-001): for any generated set of
// postings, each written posting has debits = credits and the journal as a
// whole always balances. No property-testing library is installed (no
// fast-check in package.json); this hand-rolls a small deterministic seeded
// generator (mulberry32 + generatePosting, shared with books.property.test.ts
// and tally-export.property.test.ts via ./prng) so failures are reproducible.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-021 property: journal balance invariant (TC-FIN-001)', () => {
  it('every written posting balances, and the journal as a whole always balances', async () => {
    const db = new Database(new Scope(`str-021-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const rand = mulberry32(20260720);
    const POSTING_COUNT = 40;
    let successCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < POSTING_COUNT; i++) {
      const { balanced, lines } = generatePosting(rand);
      const debitTotal = formatMoney(
        lines.filter(l => l.direction === 'debit').reduce((sum, l) => sum + parseMoney(l.amount), 0n),
      );
      const creditTotal = formatMoney(
        lines.filter(l => l.direction === 'credit').reduce((sum, l) => sum + parseMoney(l.amount), 0n),
      );

      if (balanced) {
        expect(moneyEquals(debitTotal, creditTotal)).toBe(true);
        const { entryId } = await postJournalEntry(db, `property posting ${i}`, lines);
        successCount++;

        const rows = await db.query<{ direction: string; total: string }>(
          sql`SELECT direction, SUM(amount)::text AS total FROM journal_lines WHERE entry_id = ${entryId} GROUP BY direction`,
        );
        const totals = Object.fromEntries(rows.map(r => [r.direction, r.total]));
        expect(moneyEquals(totals.debit, totals.credit)).toBe(true);
      } else {
        expect(moneyEquals(debitTotal, creditTotal)).toBe(false);
        await expect(postJournalEntry(db, `property posting ${i}`, lines)).rejects.toThrow(JournalError);
        rejectedCount++;
      }
    }

    // Sanity: the generator actually exercised both branches.
    expect(successCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);

    // The journal as a whole always balances: total debits == total credits
    // across every written line, not just per-entry.
    const journalTotals = await db.query<{ direction: string; total: string }>(
      sql`SELECT direction, SUM(amount)::text AS total FROM journal_lines GROUP BY direction`,
    );
    const totalsByDirection = Object.fromEntries(journalTotals.map(r => [r.direction, r.total]));
    expect(moneyEquals(totalsByDirection.debit, totalsByDirection.credit)).toBe(true);

    const entryCount = await db.queryOne<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM journal_entries`);
    expect(Number(entryCount!.count)).toBe(successCount);
  });
});
