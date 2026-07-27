import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { getPostingsInPeriod, buildDayBookVouchersXml } from '../../aws-blocks/finance/tally-export';
import { moneyEquals, sumMoney } from '../../aws-blocks/money';
import { mulberry32, generatePosting } from './prng';

// STR-102 — T-P1 (BE-P, covers TC-FIN-040): for any generated set of
// balanced postings with randomized posted_at timestamps and a randomized
// [from, to] window, the exported voucher XML contains exactly one
// <VOUCHER> per posting whose posted_at (IST calendar date) falls inside
// the window and none whose doesn't; and summing the exported vouchers'
// ledger-entry amounts by direction reproduces the same debit/credit
// totals as summing journal_lines directly over that window -- the
// reconciliation property the epic's Risks section names. Only balanced
// postings are generated (filtered via generatePosting's `balanced` flag)
// since only valid postings ever reach journal_entries in the first place.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

/** Adds `days` (may be 0) to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A deterministic pseudo-random ISO timestamp within `rangeDays` of `baseDate`. */
function randomTimestamp(rand: () => number, baseDate: string, rangeDays: number): string {
  const dayOffset = Math.floor(rand() * rangeDays);
  const hour = Math.floor(rand() * 24);
  const minute = Math.floor(rand() * 60);
  const date = new Date(`${addDays(baseDate, dayOffset)}T00:00:00Z`);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
}

/** Extracts each <ALLLEDGERENTRIES.LIST> entry's direction (from ISDEEMEDPOSITIVE) and unsigned amount. */
function extractLedgerEntries(xml: string): Array<{ direction: 'debit' | 'credit'; amount: string }> {
  const entryPattern = /<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?\d+\.\d{2})<\/AMOUNT>/g;
  const entries: Array<{ direction: 'debit' | 'credit'; amount: string }> = [];
  for (const match of xml.matchAll(entryPattern)) {
    const direction = match[1] === 'Yes' ? 'debit' : 'credit';
    const amount = match[2].replace('-', '');
    entries.push({ direction, amount });
  }
  return entries;
}

describe('STR-102 property: day-book voucher export reconciliation (TC-FIN-040)', () => {
  it('exports exactly one voucher per in-period posting and reconciles debit/credit totals with the journal', async () => {
    const db = new Database(new Scope(`str-102-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const rand = mulberry32(20260727);
    const BASE_DATE = '2026-06-01';
    const RANGE_DAYS = 60;
    const POSTING_COUNT = 40;

    for (let i = 0; i < POSTING_COUNT; i++) {
      const { balanced, lines } = generatePosting(rand);
      const postedAt = randomTimestamp(rand, BASE_DATE, RANGE_DAYS);
      if (!balanced) continue; // only valid postings ever reach journal_entries
      await postJournalEntry(db, `property posting ${i}`, lines, { postedAt });
    }

    const fromOffset = Math.floor(rand() * RANGE_DAYS);
    const toOffset = Math.floor(rand() * RANGE_DAYS);
    const from = addDays(BASE_DATE, Math.min(fromOffset, toOffset));
    const to = addDays(BASE_DATE, Math.max(fromOffset, toOffset));

    const expectedCountRow = await db.queryOne<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM journal_entries je
          WHERE (je.posted_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date`,
    );
    const expectedCount = Number(expectedCountRow!.count);

    const expectedTotalsRows = await db.query<{ direction: string; total: string }>(
      sql`SELECT jl.direction, SUM(jl.amount)::text AS total
          FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE (je.posted_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
          GROUP BY jl.direction`,
    );
    const expectedTotals = Object.fromEntries(expectedTotalsRows.map(r => [r.direction, r.total]));

    const postings = await getPostingsInPeriod(db, from, to);
    expect(postings).toHaveLength(expectedCount);

    const xml = buildDayBookVouchersXml(postings);
    const voucherMatches = xml.match(/<VOUCHER /g) ?? [];
    expect(voucherMatches).toHaveLength(expectedCount);

    const ledgerEntries = extractLedgerEntries(xml);
    const exportedTotals = {
      debit: sumMoney(ledgerEntries.filter(e => e.direction === 'debit').map(e => e.amount)),
      credit: sumMoney(ledgerEntries.filter(e => e.direction === 'credit').map(e => e.amount)),
    };

    if (expectedTotals.debit !== undefined) {
      expect(moneyEquals(exportedTotals.debit, expectedTotals.debit)).toBe(true);
    } else {
      expect(exportedTotals.debit).toBe('0.00');
    }
    if (expectedTotals.credit !== undefined) {
      expect(moneyEquals(exportedTotals.credit, expectedTotals.credit)).toBe(true);
    } else {
      expect(exportedTotals.credit).toBe('0.00');
    }

    // Sanity: the window actually excluded at least one posting and
    // included at least one -- otherwise this run degenerated to a trivial
    // all-or-nothing window and didn't exercise the boundary.
    expect(expectedCount).toBeGreaterThan(0);
    expect(expectedCount).toBeLessThan(POSTING_COUNT);
  });
});
