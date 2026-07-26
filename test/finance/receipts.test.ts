import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { allocateReceiptSeriesNumber } from '../../aws-blocks/finance/receipts';

// STR-071 -- the raw gapless per-FY receipt number allocator. Follows the
// STR-021 test pattern (test/finance/journal.test.ts): fresh Database +
// Scope per test, migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-071-test-${randomUUID()}`), 'db');
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

describe('STR-071 allocateReceiptSeriesNumber', () => {
  // T-U1 (partially covers TC-FIN-020: the raw allocation number; STR-073
  // completes the case with the formatted string): the first allocation for
  // a brand-new FY label returns 1.
  it('returns 1 for the first allocation against a brand-new FY label', async () => {
    const db = await freshMigratedDb();

    const allocated = await db.transaction(tx => allocateReceiptSeriesNumber(tx, '2026-27'));

    expect(allocated).toBe(1);
  });

  // T-U2: an allocation made inside a transaction that is then rolled back
  // consumes no number -- the next real allocation still returns the same
  // value the rolled-back call got.
  it('consumes no number when the allocating transaction rolls back', async () => {
    const db = await freshMigratedDb();

    let rolledBackNumber: number | undefined;
    await expect(
      db.transaction(async tx => {
        rolledBackNumber = await allocateReceiptSeriesNumber(tx, 'FY-X');
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(rolledBackNumber).toBe(1);

    const allocated = await db.transaction(tx => allocateReceiptSeriesNumber(tx, 'FY-X'));
    expect(allocated).toBe(1);
  });

  // T-P1 (BE-P, covers TC-FIN-021): N concurrent allocations against the
  // same FY label return N distinct integers with no gaps -- the returned
  // set is exactly {1..N}. Each allocation commits normally (none roll
  // back), fired concurrently via Promise.all.
  //
  // Scope of what this actually proves: this repo's local `@aws-blocks/bb-data`
  // PGlite-backed Database mock (aws-blocks/scripts and
  // node_modules/@aws-blocks/bb-data/src/engines/pglite-engine.ts) runs all
  // work over a single shared connection, so nested `BEGIN`s from
  // "concurrent" `db.transaction()` calls merge into the one open
  // transaction rather than running as independent, isolated Postgres
  // sessions. A rollback on any one of these merged transactions can
  // silently undo another transaction's already-returned allocation, so this
  // test is only valid evidence when every call commits (as it does here):
  // gaplessness and no-duplication across N allocations that all commit. It
  // does NOT prove cross-connection atomicity under concurrent load -- that
  // rests on the `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` upsert
  // pattern in allocateReceiptSeriesNumber being race-free under a real
  // Postgres connection pool, which this local, AWS-free suite cannot
  // exercise.
  it('N concurrent allocations against the same FY label return exactly {1..N} with no gaps or duplicates', async () => {
    const db = await freshMigratedDb();
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () => db.transaction(tx => allocateReceiptSeriesNumber(tx, '2026-27-concurrent'))),
    );

    const seen = new Set(results);
    expect(seen.size).toBe(N);
    expect(seen).toEqual(new Set(Array.from({ length: N }, (_, i) => i + 1)));
  });
});
