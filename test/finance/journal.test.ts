import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry, JournalError } from '../../aws-blocks/finance/journal';

// STR-021 — append-only double-entry journal, unit cases. Follows the
// STR-011 migration-runner test pattern: fresh Database + Scope per test,
// baseline + finance migrations applied via MIGRATIONS_DIR (the real
// migrations directory, not a fixture dir).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-021-test-${randomUUID()}`), 'db');
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

describe('STR-021 posting writer — append-only double-entry journal', () => {
  // T-U1 (covers TC-FIN-002): Given an unbalanced posting (debits != credits);
  // When submitted; Then it is rejected and nothing is written.
  it('rejects an unbalanced posting and writes nothing', async () => {
    const db = await freshMigratedDb();

    await expect(
      postJournalEntry(db, 'unbalanced test posting', [
        { accountId: 'cash', direction: 'debit', amount: '100.00' },
        { accountId: 'bank', direction: 'credit', amount: '99.99' },
      ]),
    ).rejects.toThrow(JournalError);

    const entries = await db.query(sql`SELECT * FROM journal_entries`);
    const lines = await db.query(sql`SELECT * FROM journal_lines`);
    expect(entries).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  // Regression: a balanced-but-zero posting (debits == credits, both "0.00")
  // must be rejected as a domain error before anything is written, not left
  // to the `journal_lines` CHECK (amount > 0) constraint to catch deep in
  // the transaction.
  it('rejects a zero-amount posting and writes nothing', async () => {
    const db = await freshMigratedDb();

    await expect(
      postJournalEntry(db, 'zero amount test posting', [
        { accountId: 'cash', direction: 'debit', amount: '0.00' },
        { accountId: 'bank', direction: 'credit', amount: '0.00' },
      ]),
    ).rejects.toThrow(JournalError);

    const entries = await db.query(sql`SELECT * FROM journal_entries`);
    const lines = await db.query(sql`SELECT * FROM journal_lines`);
    expect(entries).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  // T-U2 (covers TC-FIN-009): amounts posted as decimal strings read back
  // exactly, as strings — including amounts that would visibly round-trip
  // wrong under float arithmetic ("0.10" + "0.20").
  it('round-trips decimal-string amounts exactly, never as JS numbers', async () => {
    const db = await freshMigratedDb();

    const { entryId } = await postJournalEntry(db, 'exactness test posting', [
      { accountId: 'cash', direction: 'debit', amount: '0.10' },
      { accountId: 'cash', direction: 'debit', amount: '0.20' },
      { accountId: 'bank', direction: 'credit', amount: '0.30' },
    ]);

    const rows = await db.query<{ amount: string; direction: string }>(
      sql`SELECT amount, direction FROM journal_lines WHERE entry_id = ${entryId} ORDER BY amount`,
    );
    const amounts = rows.map(r => r.amount);
    for (const amount of amounts) expect(typeof amount).toBe('string');
    expect(amounts).toEqual(['0.10', '0.20', '0.30']);

    const { entryId: entryId2 } = await postJournalEntry(db, 'round trip 1250.00', [
      { accountId: 'cash', direction: 'debit', amount: '1250.00' },
      { accountId: 'bank', direction: 'credit', amount: '1250.00' },
    ]);
    const row2 = await db.queryOne<{ amount: string }>(
      sql`SELECT amount FROM journal_lines WHERE entry_id = ${entryId2} AND direction = 'debit'`,
    );
    expect(typeof row2!.amount).toBe('string');
    expect(row2!.amount).toBe('1250.00');
  });

  // T-U3: a posting referencing a non-existent ledger account is rejected;
  // bank and cash accounts exist as ledger accounts after migration.
  it('rejects a posting referencing an unknown ledger account, and seeds cash/bank accounts', async () => {
    const db = await freshMigratedDb();

    const accounts = await db.query<{ id: string; kind: string }>(
      sql`SELECT id, kind FROM ledger_accounts ORDER BY id`,
    );
    expect(accounts).toEqual([
      { id: 'bank', kind: 'bank' },
      { id: 'cash', kind: 'cash' },
      // STR-042: 011_employees.sql seeds a third ledger account, 'expense'.
      { id: 'expense', kind: 'expense' },
    ]);

    await expect(
      postJournalEntry(db, 'unknown account posting', [
        { accountId: 'cash', direction: 'debit', amount: '10.00' },
        { accountId: 'does-not-exist', direction: 'credit', amount: '10.00' },
      ]),
    ).rejects.toThrow(JournalError);

    const entries = await db.query(sql`SELECT * FROM journal_entries`);
    expect(entries).toHaveLength(0);
  });

  // T-U4: the finance migrations (000_baseline.sql + 001_finance_journal.sql)
  // apply idempotently on a clean database via runLocalMigrations — first run
  // applies both, second run is a no-op (mirrors STR-011's T-U2 pattern).
  it('applies the finance migrations idempotently', async () => {
    const db = new Database(new Scope(`str-021-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);

    const first = await runLocalMigrations(db, MIGRATIONS_DIR);
    expect(first.applied).toEqual([
      '000_baseline.sql',
      '001_finance_journal.sql',
      '002_journal_immutability.sql',
      '003_reversal_uniqueness.sql',
      '004_book_counterparty.sql',
      '005_journal_entry_documents.sql',
      '006_members_projects.sql',
      '007_assets.sql',
      '008_member_lifecycle.sql',
      '009_member_status_timestamp.sql',
      '010_member_cessation.sql',
      '011_employees.sql',
      '012_project_committees.sql',
      '013_role_assignments.sql',
      '014_ownerships.sql',
      '015_capability_designations.sql',
      '016_ownership_transfer.sql',
      '017_asset_view_grants.sql',
      '018_charges.sql',
      '019_charges_idempotency.sql',
      '020_registered_devices.sql',
      '021_charges_late_fee.sql',
      '022_charges_late_fee_kind_scope.sql',
      '023_receipt_series_counters.sql',
    ]);

    const second = await runLocalMigrations(db, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
  });

  // Regression: the RDS Data API sends string parameters as untyped
  // `stringValue` (no typeHint), and Postgres refuses to implicitly
  // assign-cast text to a NUMERIC column -- a real-sandbox-only failure
  // ("column amount is of type numeric but expression is of type text")
  // that PGlite never surfaces locally. Asserted at the query-text level,
  // via the engine actually used to run the transaction's INSERT, since
  // PGlite accepts the cast as a no-op either way.
  it('the journal_lines INSERT casts the amount parameter, not just interpolates it as text', async () => {
    const db = await freshMigratedDb();
    const engine = await db.getEngine();
    const executeSpy = vi.spyOn(engine, 'executeInTransaction');

    await postJournalEntry(db, 'cast regression posting', [
      { accountId: 'cash', direction: 'debit', amount: '10.00' },
      { accountId: 'bank', direction: 'credit', amount: '10.00' },
    ]);

    const insertCall = executeSpy.mock.calls.find(([, sql]) => sql.includes('INSERT INTO journal_lines'));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toMatch(/\$\d+::numeric/);
  });

  it('the journal_entries INSERT casts an explicit posted_at parameter, not just interpolates it as text', async () => {
    const db = await freshMigratedDb();
    const engine = await db.getEngine();
    const executeSpy = vi.spyOn(engine, 'executeInTransaction');

    await postJournalEntry(
      db,
      'cast regression posting with explicit postedAt',
      [
        { accountId: 'cash', direction: 'debit', amount: '10.00' },
        { accountId: 'bank', direction: 'credit', amount: '10.00' },
      ],
      { postedAt: '2026-01-01T00:00:00.000Z' },
    );

    const insertCall = executeSpy.mock.calls.find(([, sql]) => sql.includes('INSERT INTO journal_entries') && sql.includes('posted_at'));
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toMatch(/\$\d+::timestamptz/);
  });

  // Regression: the RDS Data API has no array Field type -- a bare JS array
  // marshals as a JSON string, which Postgres's `ANY()` rejects -- a
  // real-Aurora-only failure PGlite never surfaces locally. Asserted at the
  // query-text level since PGlite accepts the pgTextArray + ::text[] cast
  // as a no-op either way.
  it('the ledger_accounts existence check casts the referenced-account-ids array parameter', async () => {
    const db = await freshMigratedDb();

    await expect(
      postJournalEntry(db, 'cast regression account check', [
        { accountId: 'cash', direction: 'debit', amount: '10.00' },
        { accountId: 'bank', direction: 'credit', amount: '10.00' },
      ]),
    ).resolves.toBeDefined();

    const queryRawSpy = vi.spyOn(db, 'query');
    await postJournalEntry(db, 'second posting', [
      { accountId: 'cash', direction: 'debit', amount: '5.00' },
      { accountId: 'bank', direction: 'credit', amount: '5.00' },
    ]);

    const accountCheckCall = queryRawSpy.mock.calls.map(([query]) => query).find(query => query.sql.includes('ledger_accounts'));
    expect(accountCheckCall).toBeDefined();
    expect(accountCheckCall!.sql).toMatch(/ANY\(\$\d+::text\[\]\)/);
  });
});
