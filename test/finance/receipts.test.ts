import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { allocateReceiptSeriesNumber, formatReceiptNumber, buildReceiptFormat } from '../../aws-blocks/finance/receipts';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole, vacateRole } from '../../aws-blocks/members/role-assignments';

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

// STR-073: FY-boundary rollover of the receipt series -- wraps STR-071's
// allocateReceiptSeriesNumber with the IST-based FY resolution and the
// `<prefix>/<fy-label>/<counter>` formatting. Tests set the singleton
// society_settings row directly via SQL -- there is no HTTP endpoint (same
// minimal-scope precedent as charge_settings, see test/payments/charge-run.test.ts).
async function seedReceiptPrefix(db: Database, prefix: string): Promise<void> {
  await db.execute(sql`UPDATE society_settings SET receipt_prefix = ${prefix} WHERE id = 'default'`);
}

describe('STR-073 formatReceiptNumber', () => {
  // T-U1 (covers TC-FIN-022): a receipt dated Mar 31 formats under the
  // outgoing FY label; one dated Apr 1 (same year, one day later) formats
  // under the new FY label with the counter restarted at 000001.
  it('restarts the counter at 000001 under the new FY label the day after the FY boundary', async () => {
    const db = await freshMigratedDb();
    await seedReceiptPrefix(db, 'SOC');

    const beforeBoundary = await db.transaction(tx => formatReceiptNumber(tx, '2026-03-31T10:00:00Z'));
    expect(beforeBoundary).toBe('SOC/2025-26/000001');

    const afterBoundary = await db.transaction(tx => formatReceiptNumber(tx, '2026-04-01T10:00:00Z'));
    expect(afterBoundary).toBe('SOC/2026-27/000001');
  });

  // T-U2: FY resolution is computed against the IST calendar date, not
  // UTC -- a timestamp in the UTC evening of Mar 31 that is already IST
  // Apr 1 (the ~5.5-hour skew window) lands in the new FY, not the old one.
  it('assigns a UTC-evening-of-Mar-31 timestamp that is already IST Apr 1 to the new FY', async () => {
    const db = await freshMigratedDb();
    await seedReceiptPrefix(db, 'SOC');

    // 2026-03-31T20:00:00Z is 2026-04-01T01:30 IST (UTC+5:30).
    const receiptNumber = await db.transaction(tx => formatReceiptNumber(tx, '2026-03-31T20:00:00Z'));

    expect(receiptNumber).toBe('SOC/2026-27/000001');
  });

  // T-U3: the formatted string matches <prefix>/<fy-label>/<6-digit-zero-padded-counter> exactly.
  it('formats as <prefix>/<fy-label>/<6-digit-zero-padded-counter>', async () => {
    const db = await freshMigratedDb();
    await seedReceiptPrefix(db, 'SOC');

    const receiptNumber = await db.transaction(tx => formatReceiptNumber(tx, '2026-04-01T10:00:00Z'));

    expect(receiptNumber).toBe('SOC/2026-27/000001');
  });

  // Review finding: society_settings.receipt_prefix is seeded as '' (the
  // migration's "not yet configured" placeholder, same spirit as
  // charge_settings' 0.00 default) -- an unconfigured prefix must fail
  // loudly rather than silently mint a prefix-less receipt number.
  it('throws if receipt_prefix has not been configured yet', async () => {
    const db = await freshMigratedDb();

    await expect(db.transaction(tx => formatReceiptNumber(tx, '2026-04-01T10:00:00Z'))).rejects.toThrow(
      'society_settings.receipt_prefix is not configured',
    );
  });
});

// STR-075: GSTIN-driven receipt format switching with Treasurer attribution
// -- buildReceiptFormat decides the receipt's shape (plain vs GST) from
// society_settings.gstin and, for the GST shape, resolves the currently-open
// treasurer role assignment's member name (STR-041). No HTTP endpoint --
// gstin is set directly by SQL, same precedent as receipt_prefix above.
async function seedGstin(db: Database, gstin: string): Promise<void> {
  await db.execute(sql`UPDATE society_settings SET gstin = ${gstin} WHERE id = 'default'`);
}

/** Creates an active member holding an open `treasurer` assignment --
 * mirrors test/members/role-assignments.test.ts's activeMember helper plus
 * the management-prerequisite assignment the subset-chain requires before
 * treasurer can be assigned (STR-041). */
async function seedTreasurer(db: Database, name: string, effectiveFrom = '2026-01-01') {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  await assignRole(db, member.member_id, 'management', effectiveFrom, 'ec-admin');
  await assignRole(db, member.member_id, 'treasurer', effectiveFrom, 'ec-admin');
  return member;
}

describe('STR-075 buildReceiptFormat', () => {
  // T-U1 (covers TC-FIN-023): a society with no gstin configured produces a
  // plain-format result -- no gstin field, no GST fields present.
  it('produces a plain-format result when no gstin is configured', async () => {
    const db = await freshMigratedDb();

    const format = await buildReceiptFormat(db);

    expect(format).toEqual({ kind: 'plain' });
    expect(format).not.toHaveProperty('gstin');
    expect(format).not.toHaveProperty('treasurerName');
  });

  // T-U2 (covers TC-FIN-024): a society with a gstin configured produces a
  // GST-format result carrying that gstin and the current Treasurer's
  // printed name; no signature-image field exists anywhere in the shape.
  it('produces a GST-format result carrying the gstin and the current Treasurer name', async () => {
    const db = await freshMigratedDb();
    await seedGstin(db, '27AAAAA0000A1Z5');
    await seedTreasurer(db, 'Treasurer One');

    const format = await buildReceiptFormat(db);

    expect(format).toEqual({ kind: 'gst', gstin: '27AAAAA0000A1Z5', treasurerName: 'Treasurer One' });
    expect(Object.keys(format).sort()).toEqual(['gstin', 'kind', 'treasurerName']);
    expect(format).not.toHaveProperty('signature');
    expect(format).not.toHaveProperty('signatureImage');
  });

  // T-U3: the printed Treasurer name reflects whoever currently holds the
  // OPEN treasurer role assignment, not a hardcoded/separately configured
  // name -- a role handover after a receipt was already "issued" (i.e.
  // buildReceiptFormat already returned a resolved name) does not
  // retroactively change that already-resolved value, and a subsequent call
  // reads the new incumbent's name live rather than a cached one.
  it('resolves the Treasurer name live from the currently-open role assignment, not a cached/hardcoded value', async () => {
    const db = await freshMigratedDb();
    await seedGstin(db, '27AAAAA0000A1Z5');
    const first = await seedTreasurer(db, 'Treasurer One', '2026-01-01');

    const issuedBeforeHandover = await buildReceiptFormat(db);
    expect(issuedBeforeHandover).toEqual({ kind: 'gst', gstin: '27AAAAA0000A1Z5', treasurerName: 'Treasurer One' });

    await vacateRole(db, first.member_id, 'treasurer', '2026-06-01', 'ec-admin');
    await seedTreasurer(db, 'Treasurer Two', '2026-06-01');

    // The already-returned result from before the handover is unaffected.
    expect(issuedBeforeHandover).toEqual({ kind: 'gst', gstin: '27AAAAA0000A1Z5', treasurerName: 'Treasurer One' });

    // A fresh call after the handover reads the new incumbent live.
    const issuedAfterHandover = await buildReceiptFormat(db);
    expect(issuedAfterHandover).toEqual({ kind: 'gst', gstin: '27AAAAA0000A1Z5', treasurerName: 'Treasurer Two' });
  });
});
