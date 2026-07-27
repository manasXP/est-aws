import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { allocateReceiptSeriesNumber, formatReceiptNumber, buildReceiptFormat, computeGstTaxLines, issueReceipt } from '../../aws-blocks/finance/receipts';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole, vacateRole } from '../../aws-blocks/members/role-assignments';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { getDocumentLinksForEntry, isDocumentLinkedToLedger } from '../../aws-blocks/finance/documents';
import { parseMoney, formatMoney } from '../../aws-blocks/money';

// STR-071 -- the raw gapless per-FY receipt number allocator. Follows the
// STR-021 test pattern (test/finance/journal.test.ts): fresh Database +
// Scope per test, migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-071-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-079-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
}

async function postSamplePosting(db: Database): Promise<string> {
  const { entryId } = await postJournalEntry(db, 'sample posting', [
    { accountId: 'cash', direction: 'debit', amount: '100.00' },
    { accountId: 'bank', direction: 'credit', amount: '100.00' },
  ]);
  return entryId;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
  while (cleanupBuckets.length) {
    const bucket = cleanupBuckets.pop()!;
    rmSync(`.bb-data/${bucket.fullId}`, { recursive: true, force: true });
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

    const format = await buildReceiptFormat(db, '1180.00');

    expect(format).toEqual({ kind: 'plain' });
    expect(format).not.toHaveProperty('gstin');
    expect(format).not.toHaveProperty('treasurerName');
  });

  // STR-077 T-U2: a plain-format result never carries tax-line fields,
  // regardless of what totalAmount is passed in.
  it('never carries tax-line fields for a plain-format result', async () => {
    const db = await freshMigratedDb();

    const format = await buildReceiptFormat(db, '1180.00');

    expect(format).not.toHaveProperty('taxableAmount');
    expect(format).not.toHaveProperty('cgstAmount');
    expect(format).not.toHaveProperty('sgstAmount');
  });

  // T-U2 (covers TC-FIN-024): a society with a gstin configured produces a
  // GST-format result carrying that gstin and the current Treasurer's
  // printed name; no signature-image field exists anywhere in the shape.
  it('produces a GST-format result carrying the gstin and the current Treasurer name', async () => {
    const db = await freshMigratedDb();
    await seedGstin(db, '27AAAAA0000A1Z5');
    await seedTreasurer(db, 'Treasurer One');

    const format = await buildReceiptFormat(db, '1180.00');

    expect(format).toEqual({
      kind: 'gst',
      gstin: '27AAAAA0000A1Z5',
      treasurerName: 'Treasurer One',
      taxableAmount: '1000.00',
      cgstAmount: '90.00',
      sgstAmount: '90.00',
    });
    expect(Object.keys(format).sort()).toEqual([
      'cgstAmount',
      'gstin',
      'kind',
      'sgstAmount',
      'taxableAmount',
      'treasurerName',
    ]);
    expect(format).not.toHaveProperty('signature');
    expect(format).not.toHaveProperty('signatureImage');
  });

  // T-U3: the printed Treasurer name reflects whoever currently holds the
  // OPEN treasurer role assignment, not a hardcoded/separately configured
  // name -- after a role handover, a fresh call reads the new incumbent's
  // name live rather than a cached/stale one.
  it('resolves the Treasurer name live from the currently-open role assignment, not a cached/hardcoded value', async () => {
    const db = await freshMigratedDb();
    await seedGstin(db, '27AAAAA0000A1Z5');
    const first = await seedTreasurer(db, 'Treasurer One', '2026-01-01');

    const issuedBeforeHandover = await buildReceiptFormat(db, '1180.00');
    expect(issuedBeforeHandover).toEqual({
      kind: 'gst',
      gstin: '27AAAAA0000A1Z5',
      treasurerName: 'Treasurer One',
      taxableAmount: '1000.00',
      cgstAmount: '90.00',
      sgstAmount: '90.00',
    });

    await vacateRole(db, first.member_id, 'treasurer', '2026-06-01', 'ec-admin');
    await seedTreasurer(db, 'Treasurer Two', '2026-06-01');

    // A fresh call after the handover reads the new incumbent live, not the
    // value already returned above.
    const issuedAfterHandover = await buildReceiptFormat(db, '1180.00');
    expect(issuedAfterHandover).toEqual({
      kind: 'gst',
      gstin: '27AAAAA0000A1Z5',
      treasurerName: 'Treasurer Two',
      taxableAmount: '1000.00',
      cgstAmount: '90.00',
      sgstAmount: '90.00',
    });
  });

  // Review finding: assignRole only guards a member double-holding a role,
  // not two different members both holding an open treasurer assignment
  // (e.g. an operator assigning a successor before vacating the
  // predecessor) -- getCurrentTreasurerName must fail loudly rather than
  // silently pick one, since this feeds a statutory GST receipt.
  it('throws if two different members both hold an open treasurer assignment', async () => {
    const db = await freshMigratedDb();
    await seedGstin(db, '27AAAAA0000A1Z5');
    await seedTreasurer(db, 'Treasurer One', '2026-01-01');
    await seedTreasurer(db, 'Treasurer Two', '2026-01-01');

    await expect(buildReceiptFormat(db, '1180.00')).rejects.toThrow('multiple open treasurer role assignments');
  });
});

// STR-079: E08's capstone -- issueReceipt assembles STR-071/073's number,
// STR-075/077's format, and STR-025's document link into one persisted,
// ledger-linked receipt.
describe('STR-079 issueReceipt', () => {
  // T-U1 (covers TC-FIN-060): issuing a receipt against a real journal entry
  // stores a document and links it to that entry; the link resolves to a
  // presigned download.
  it('stores a document and links it to the journal entry, resolving to a presigned download', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const entryId = await postSamplePosting(db);

    const result = await issueReceipt(db, bucket, entryId, '1180.00');

    const links = await getDocumentLinksForEntry(db, bucket, entryId);
    expect(links).toHaveLength(1);
    expect(links[0].documentId).toBe(result.documentPath);
    expect(links[0].downloadUrl).toEqual(expect.any(String));
    expect(links[0].downloadUrl.length).toBeGreaterThan(0);
  });

  // T-U2: the returned IssueReceiptResult and the persisted receipts row
  // carry the right receiptNumber/fyLabel/amount for a plain society, and
  // the GST fields (round-tripped, not silently re-derived) for a
  // GST-registered society.
  it('persists the receipt number, FY label, and amount for a plain (non-GST) society', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const entryId = await postSamplePosting(db);

    // Fixed, obviously-not-coincidental issuedOnDate -- avoids wall-clock
    // coupling to today's FY (this test would otherwise start failing after
    // the FY rolls over on 2027-04-01).
    const result = await issueReceipt(db, bucket, entryId, '1180.00', { issuedOnDate: '2031-06-15T10:00:00Z' });

    expect(result.receiptNumber).toBe('SOC/2031-32/000001');
    expect(result.fyLabel).toBe('2031-32');
    expect(result.amount).toBe('1180.00');
    expect(result.gstin).toBeNull();

    const row = await db.queryOne<{ receipt_number: string; fy_label: string; amount: string }>(
      sql`SELECT receipt_number, fy_label, amount FROM receipts WHERE entry_id = ${entryId}`,
    );
    expect(row!.receipt_number).toBe('SOC/2031-32/000001');
    expect(row!.fy_label).toBe('2031-32');
    expect(row!.amount).toBe('1180.00');
  });

  // Review finding: buildReceiptFormat only calls parseMoney inside its GST
  // branch, so a plain (non-GST) society never validated totalAmount at all
  // -- issueReceipt must reject a malformed amount up front, before writing
  // anything, regardless of GST status.
  it('rejects a malformed amount for a plain (non-GST) society, writing nothing', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const entryId = await postSamplePosting(db);

    await expect(issueReceipt(db, bucket, entryId, 'not-a-valid-amount')).rejects.toThrow();

    const row = await db.queryOne(sql`SELECT * FROM receipts WHERE entry_id = ${entryId}`);
    expect(row).toBeNull();
  });

  it('persists the GST tax-line fields, matching computeGstTaxLines independently, for a GST-registered society', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    await seedGstin(db, '27AAAAA0000A1Z5');
    await seedTreasurer(db, 'Treasurer One');
    const entryId = await postSamplePosting(db);
    const amount = '1180.00';

    // Fixed, obviously-not-coincidental issuedOnDate -- avoids wall-clock
    // coupling to today's FY (this test would otherwise start failing after
    // the FY rolls over on 2027-04-01).
    const result = await issueReceipt(db, bucket, entryId, amount, { issuedOnDate: '2031-06-15T10:00:00Z' });

    const expected = computeGstTaxLines(parseMoney(amount));
    expect(result.taxableAmount).toBe(formatMoney(expected.taxableAmount));
    expect(result.cgstAmount).toBe(formatMoney(expected.cgstAmount));
    expect(result.sgstAmount).toBe(formatMoney(expected.sgstAmount));
    expect(result.gstin).toBe('27AAAAA0000A1Z5');
    expect(result.treasurerName).toBe('Treasurer One');

    const row = await db.queryOne<{ taxable_amount: string; cgst_amount: string; sgst_amount: string; gstin: string; treasurer_name: string }>(
      sql`SELECT taxable_amount, cgst_amount, sgst_amount, gstin, treasurer_name FROM receipts WHERE entry_id = ${entryId}`,
    );
    expect(row!.taxable_amount).toBe(result.taxableAmount);
    expect(row!.cgst_amount).toBe(result.cgstAmount);
    expect(row!.sgst_amount).toBe(result.sgstAmount);
    expect(row!.gstin).toBe('27AAAAA0000A1Z5');
    expect(row!.treasurer_name).toBe('Treasurer One');
  });

  // T-U3 (covers TC-FIN-061): after issueReceipt, the generated document
  // fails the same archive-blocking guard any other ledger-linked document
  // does.
  it('reports the generated receipt document as ledger-linked, blocking archival', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const entryId = await postSamplePosting(db);

    const result = await issueReceipt(db, bucket, entryId, '1180.00');

    await expect(isDocumentLinkedToLedger(db, result.documentPath)).resolves.toBe(true);
  });

  // T-U4: issuing a receipt for a nonexistent journal entry fails and writes
  // nothing -- no orphaned counter allocation, no orphaned row.
  it('rejects a nonexistent entryId, writing no receipt row and allocating no counter', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const badEntryId = randomUUID();

    await expect(issueReceipt(db, bucket, badEntryId, '1180.00')).rejects.toThrow();

    const row = await db.queryOne(sql`SELECT * FROM receipts WHERE entry_id = ${badEntryId}`);
    expect(row).toBeNull();

    const counter = await db.queryOne(sql`SELECT * FROM receipt_series_counters WHERE fy_label = '2026-27'`);
    expect(counter).toBeNull();

    // Review finding: the SQL-side assertions above pass even under a real
    // reordering regression that writes the document to the bucket before
    // the entry-existence check, because the whole DB transaction rolls back
    // on any throw -- but a FileBucket `put` is not part of that transaction
    // and is NOT rolled back. Assert directly on the bucket to prove no
    // document was ever written.
    const files: unknown[] = [];
    for await (const f of bucket.scan({})) files.push(f);
    expect(files).toHaveLength(0);
  });
});
