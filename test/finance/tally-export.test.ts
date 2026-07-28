import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { reverseJournalEntry } from '../../aws-blocks/finance/reversal';
import {
  getLedgerAccountsForPeriod,
  getPostingsInPeriod,
  tallyParentGroupFor,
  buildLedgerMastersXml,
  buildDayBookVouchersXml,
} from '../../aws-blocks/finance/tally-export';

// STR-101 — the ledger-masters half of E11's Tally export (TC-FIN-041):
// the distinct ledger_accounts referenced by in-period journal_lines,
// formatted as Tally <LEDGER> masters. Follows the STR-023/024 test
// pattern: fresh Database + Scope per test, baseline + finance migrations
// applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-101-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

async function insertLedgerAccount(db: Database, id: string, name: string, kind: string): Promise<void> {
  await db.execute(sql`INSERT INTO ledger_accounts (id, name, kind) VALUES (${id}, ${name}, ${kind})`);
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-101 Tally ledger masters', () => {
  // T-U1 (covers TC-FIN-041): postings inside the requested period touch
  // cash and bank; a posting to a third account falls outside the period.
  // The masters list contains exactly cash and bank.
  it('includes accounts touched inside the period and excludes an account only touched outside it', async () => {
    const db = await freshMigratedDb();
    await insertLedgerAccount(db, 'reserve', 'Reserve Fund', 'reserve');

    await postJournalEntry(db, 'in-period bank receipt', [
      { accountId: 'bank', direction: 'debit', amount: '1000.00' },
      { accountId: 'cash', direction: 'credit', amount: '1000.00' },
    ], { postedAt: '2026-06-15T10:00:00Z' });

    await postJournalEntry(db, 'out-of-period reserve transfer', [
      { accountId: 'reserve', direction: 'debit', amount: '500.00' },
      { accountId: 'bank', direction: 'credit', amount: '500.00' },
    ], { postedAt: '2026-01-01T10:00:00Z' });

    const accounts = await getLedgerAccountsForPeriod(db, '2026-04-01', '2027-03-31');
    const ids = accounts.map(a => a.id).sort();
    expect(ids).toEqual(['bank', 'cash']);
  });

  // T-U2: an account referenced ONLY by postings outside the period
  // produces no master at all — proving no full chart-of-accounts sync,
  // not just period filtering of vouchers already selected.
  it('never lists an account that is only ever touched outside the period', async () => {
    const db = await freshMigratedDb();
    await insertLedgerAccount(db, 'reserve', 'Reserve Fund', 'reserve');

    await postJournalEntry(db, 'out-of-period reserve transfer', [
      { accountId: 'reserve', direction: 'debit', amount: '500.00' },
      { accountId: 'bank', direction: 'credit', amount: '500.00' },
    ], { postedAt: '2026-01-01T10:00:00Z' });

    const accounts = await getLedgerAccountsForPeriod(db, '2026-04-01', '2027-03-31');
    expect(accounts.some(a => a.id === 'reserve')).toBe(false);
  });

  // T-U3: an account referenced by multiple lines across multiple
  // postings in the period appears exactly once — Tally rejects a file
  // that tries to create the same ledger twice.
  it('lists an account referenced by multiple postings in the period exactly once', async () => {
    const db = await freshMigratedDb();

    await postJournalEntry(db, 'first bank receipt', [
      { accountId: 'bank', direction: 'debit', amount: '1000.00' },
      { accountId: 'cash', direction: 'credit', amount: '1000.00' },
    ], { postedAt: '2026-06-01T10:00:00Z' });

    await postJournalEntry(db, 'second bank receipt', [
      { accountId: 'bank', direction: 'debit', amount: '250.00' },
      { accountId: 'cash', direction: 'credit', amount: '250.00' },
    ], { postedAt: '2026-06-10T10:00:00Z' });

    const accounts = await getLedgerAccountsForPeriod(db, '2026-04-01', '2027-03-31');
    expect(accounts.filter(a => a.id === 'bank')).toHaveLength(1);
    expect(accounts.filter(a => a.id === 'cash')).toHaveLength(1);
  });

  // T-U4: the formatted XML gives each master a <PARENT> matching the
  // kind mapping; an unmapped kind falls back to the documented default
  // without throwing.
  describe('tallyParentGroupFor', () => {
    it('maps cash to Cash-in-hand and bank to Bank Accounts', () => {
      expect(tallyParentGroupFor('cash')).toBe('Cash-in-hand');
      expect(tallyParentGroupFor('bank')).toBe('Bank Accounts');
    });

    it('falls back to a documented default for an unmapped kind, without throwing', () => {
      expect(() => tallyParentGroupFor('reserve')).not.toThrow();
      expect(tallyParentGroupFor('reserve')).toBe('Suspense');
    });

    // Regression: a plain object literal would resolve an inherited
    // Object.prototype member instead of falling back for a kind like
    // 'constructor' or '__proto__'.
    it('falls back to the default for a kind matching an inherited Object.prototype member', () => {
      expect(tallyParentGroupFor('constructor')).toBe('Suspense');
      expect(tallyParentGroupFor('__proto__')).toBe('Suspense');
      expect(tallyParentGroupFor('hasOwnProperty')).toBe('Suspense');
    });
  });

  describe('buildLedgerMastersXml', () => {
    it('emits one <LEDGER> per account with its mapped <PARENT>', () => {
      const xml = buildLedgerMastersXml([
        { id: 'cash', name: 'Cash', kind: 'cash' },
        { id: 'bank', name: 'Bank', kind: 'bank' },
      ]);
      expect(xml).toContain('<ENVELOPE>');
      expect(xml).toContain('<LEDGER NAME="Cash" ACTION="Create">');
      expect(xml).toContain('<PARENT>Cash-in-hand</PARENT>');
      expect(xml).toContain('<LEDGER NAME="Bank" ACTION="Create">');
      expect(xml).toContain('<PARENT>Bank Accounts</PARENT>');
    });

    it('falls back to the default parent group for an unmapped kind, without throwing', () => {
      expect(() => buildLedgerMastersXml([{ id: 'reserve', name: 'Reserve Fund', kind: 'reserve' }])).not.toThrow();
      const xml = buildLedgerMastersXml([{ id: 'reserve', name: 'Reserve Fund', kind: 'reserve' }]);
      expect(xml).toContain('<PARENT>Suspense</PARENT>');
    });

    // Regression: an account name containing XML metacharacters must be
    // escaped, not interpolated raw into the NAME="..." attribute — an
    // unescaped `"` would let the value break out of the attribute and
    // inject arbitrary markup into the Tally import document.
    it('escapes XML metacharacters in the account name', () => {
      const xml = buildLedgerMastersXml([
        { id: 'evil', name: 'Evil" /><LEDGER NAME="Injected & <Bad>', kind: 'cash' },
      ]);
      expect(xml).toContain('<LEDGER NAME="Evil&quot; /&gt;&lt;LEDGER NAME=&quot;Injected &amp; &lt;Bad&gt;" ACTION="Create">');
      expect(xml).not.toContain('NAME="Evil" ');
      expect(xml).not.toContain('<LEDGER NAME="Injected');
    });
  });

  // T-U5 (covers TC-FIN-041's IST-calendar convention, matching STR-024's
  // book-window precedent): the period boundary is resolved on the IST
  // calendar date of posted_at, not UTC — a posting timestamped in the UTC
  // evening that is already IST past midnight of the period's `from` date
  // is included.
  it('resolves the period boundary on the IST calendar date, not UTC', async () => {
    const db = await freshMigratedDb();
    await insertLedgerAccount(db, 'reserve', 'Reserve Fund', 'reserve');

    // 2026-03-31T19:00:00Z is 2026-04-01T00:30 IST — already inside a
    // 2026-04-01..2027-03-31 period by the IST calendar date, even though
    // its UTC calendar date (2026-03-31) is not.
    await postJournalEntry(db, 'IST-midnight-straddling receipt', [
      { accountId: 'reserve', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ], { postedAt: '2026-03-31T19:00:00Z' });

    const accounts = await getLedgerAccountsForPeriod(db, '2026-04-01', '2027-03-31');
    expect(accounts.some(a => a.id === 'reserve')).toBe(true);
  });
});

// STR-102 — the day-book voucher half of E11's Tally export (TC-FIN-040):
// every journal posting whose posted_at falls inside the requested period
// becomes exactly one Tally <VOUCHER>, and none outside it does.
describe('STR-102 Tally day-book vouchers (TC-FIN-040)', () => {
  // T-U1: a posting dated exactly on `from` is included; one on `to` is
  // included (both bounds inclusive); one the calendar day before `from`
  // and one the day after `to` are excluded.
  it('includes postings on both inclusive bounds and excludes the days just outside them', async () => {
    const db = await freshMigratedDb();

    await postJournalEntry(db, 'on from bound', [
      { accountId: 'bank', direction: 'debit', amount: '100.00' },
      { accountId: 'cash', direction: 'credit', amount: '100.00' },
    ], { postedAt: '2026-06-10T12:00:00Z' });

    await postJournalEntry(db, 'on to bound', [
      { accountId: 'bank', direction: 'debit', amount: '200.00' },
      { accountId: 'cash', direction: 'credit', amount: '200.00' },
    ], { postedAt: '2026-06-20T12:00:00Z' });

    await postJournalEntry(db, 'day before from', [
      { accountId: 'bank', direction: 'debit', amount: '300.00' },
      { accountId: 'cash', direction: 'credit', amount: '300.00' },
    ], { postedAt: '2026-06-09T12:00:00Z' });

    await postJournalEntry(db, 'day after to', [
      { accountId: 'bank', direction: 'debit', amount: '400.00' },
      { accountId: 'cash', direction: 'credit', amount: '400.00' },
    ], { postedAt: '2026-06-21T12:00:00Z' });

    const postings = await getPostingsInPeriod(db, '2026-06-10', '2026-06-20');
    expect(postings.map(p => p.description).sort()).toEqual(['on from bound', 'on to bound']);

    const xml = buildDayBookVouchersXml(postings);
    expect(xml.match(/<VOUCHER /g) ?? []).toHaveLength(2);
    expect(xml).toContain('on from bound');
    expect(xml).toContain('on to bound');
    expect(xml).not.toContain('day before from');
    expect(xml).not.toContain('day after to');
  });

  // T-U2: a reversing entry inside the period appears as its own
  // independent voucher — no special-casing of reverses_entry_id.
  it('exports a reversing entry as its own independent voucher, with no special-casing', async () => {
    const db = await freshMigratedDb();

    const { entryId } = await postJournalEntry(db, 'original posting', [
      { accountId: 'bank', direction: 'debit', amount: '500.00' },
      { accountId: 'cash', direction: 'credit', amount: '500.00' },
    ], { postedAt: '2026-06-12T10:00:00Z' });

    await reverseJournalEntry(db, entryId, 'reversal of original posting');
    // reverseJournalEntry doesn't accept an explicit postedAt, so it lands
    // at the real `now()` -- pin the period wide enough to cover both, with
    // a far-future `to` so this test doesn't start failing when the real
    // clock passes a nearer bound (review finding on the original window).
    const postings = await getPostingsInPeriod(db, '2026-01-01', '2099-12-31');

    expect(postings).toHaveLength(2);
    const xml = buildDayBookVouchersXml(postings);
    expect(xml.match(/<VOUCHER /g) ?? []).toHaveLength(2);
    expect(xml).toContain('original posting');
    expect(xml).toContain('reversal of original posting');
  });

  // T-U3: every voucher's ledger-entry amounts round-trip as the exact
  // decimal string stored in journal_lines.amount -- no reformatting.
  it('round-trips amounts as the exact decimal strings stored in journal_lines', async () => {
    const db = await freshMigratedDb();

    await postJournalEntry(db, 'exact decimal posting', [
      { accountId: 'bank', direction: 'debit', amount: '1250.00' },
      { accountId: 'cash', direction: 'credit', amount: '1250.00' },
    ], { postedAt: '2026-06-12T10:00:00Z' });

    const postings = await getPostingsInPeriod(db, '2026-06-01', '2026-06-30');
    const xml = buildDayBookVouchersXml(postings);

    // Convention (documented in tally-export.ts): a debit line's <AMOUNT>
    // is negative, a credit line's <AMOUNT> is positive/unsigned.
    expect(xml).toContain('<AMOUNT>-1250.00</AMOUNT>');
    expect(xml).toContain('<AMOUNT>1250.00</AMOUNT>');
  });

  // T-U4 (mirrors STR-073's T-U2): the period boundary is resolved on the
  // IST calendar date of posted_at, not UTC -- a posting timestamped in the
  // UTC evening that is already IST past midnight of `from` is included.
  it('resolves the period boundary on the IST calendar date, not UTC', async () => {
    const db = await freshMigratedDb();

    // 2026-06-09T19:00:00Z is 2026-06-10T00:30 IST -- already inside a
    // 2026-06-10..2026-06-20 period by the IST calendar date, even though
    // its UTC calendar date (2026-06-09) is not.
    await postJournalEntry(db, 'IST-midnight-straddling posting', [
      { accountId: 'bank', direction: 'debit', amount: '100.00' },
      { accountId: 'cash', direction: 'credit', amount: '100.00' },
    ], { postedAt: '2026-06-09T19:00:00Z' });

    const postings = await getPostingsInPeriod(db, '2026-06-10', '2026-06-20');
    expect(postings.some(p => p.description === 'IST-midnight-straddling posting')).toBe(true);
  });

  // T-U4 mirror (review finding): the same skew on the `to` bound must
  // EXCLUDE -- a UTC-evening posting on `to`'s calendar date is already
  // IST the next day, so it falls outside the window. A UTC-date
  // implementation would wrongly include it.
  it('excludes a UTC-evening posting on the to bound that is already IST the next day', async () => {
    const db = await freshMigratedDb();

    // 2026-06-20T19:00:00Z is 2026-06-21T00:30 IST -- outside a
    // 2026-06-10..2026-06-20 period by the IST calendar date, even though
    // its UTC calendar date (2026-06-20) is the `to` bound itself.
    await postJournalEntry(db, 'IST-next-day posting on to bound', [
      { accountId: 'bank', direction: 'debit', amount: '100.00' },
      { accountId: 'cash', direction: 'credit', amount: '100.00' },
    ], { postedAt: '2026-06-20T19:00:00Z' });

    const postings = await getPostingsInPeriod(db, '2026-06-10', '2026-06-20');
    expect(postings.some(p => p.description === 'IST-next-day posting on to bound')).toBe(false);
  });
});
