import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { recordOfflinePayment, OfflinePaymentConflictError } from '../../aws-blocks/payments/offline-payments';
import { getBankBookEntries, getCashBookEntries, getPaymentLedgerEntries } from '../../aws-blocks/finance/books';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-095 -- offline cash and cheque payment recording. Service-level
// (BE-U): every case here runs directly against recordOfflinePayment, not
// through the HTTP RawRoute -- the route-level cases (T-U1 contract, T-U4
// capability gate) live in test/contract/offline-payments.contract.test.ts,
// the same split STR-086 uses between test/vendors/invoice-payments.test.ts
// and its own contract file. Fresh Database + Scope + FileBucket per test,
// following test/payments/webhook-settlement.test.ts's STR-094 pattern.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-095-offline-payments-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  await db.execute(sql`UPDATE society_settings SET receipt_prefix = 'SOC' WHERE id = 'default'`);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-095-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
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

/** Tests seed a charge directly via SQL -- there is no charge-creation HTTP
 * endpoint, the same helper shape test/payments/webhook-settlement.test.ts
 * and test/payments/payment-initiation.test.ts already use. */
async function seedDueCharge(db: Database, amount = '1250.00'): Promise<string> {
  const project = await createProject(db, { name: 'Green Meadows' });
  const member = await createMember(db, { name: 'Asha Rao' });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${member.member_id}, ${ownership.ownership_id}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

async function countRows(db: Database, table: 'journal_entries' | 'receipts' | 'offline_payments'): Promise<number> {
  const row = await db.queryOne<{ count: string }>(
    table === 'journal_entries'
      ? sql`SELECT count(*)::text AS count FROM journal_entries`
      : table === 'receipts'
        ? sql`SELECT count(*)::text AS count FROM receipts`
        : sql`SELECT count(*)::text AS count FROM offline_payments`,
  );
  return Number(row!.count);
}

describe('STR-095 recordOfflinePayment', () => {
  // T-U2 (covers TC-PAY-061): a cheque payment debits the Bank Book, not the
  // Cash Book -- a cheque clears through the society's bank account, never
  // cash-in-hand. Same charge amount; only the debited account differs from
  // the cash path.
  it('posts a cheque payment to the Bank Book and nothing to the Cash Book', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const chargeId = await seedDueCharge(db, '1250.00');

    const result = await recordOfflinePayment(
      db,
      bucket,
      chargeId,
      { employeeId: 'emp-1' },
      { method: 'cheque', amount: '1250.00', receivedOn: '2026-08-05', reference: 'CHQ-4471' },
      randomUUID(),
    );

    const bank = await getBankBookEntries(db);
    expect(bank).toHaveLength(1);
    expect(bank[0].account_id).toBe('bank');
    expect(bank[0].direction).toBe('debit');
    expect(bank[0].amount).toBe('1250.00');

    expect(await getCashBookEntries(db)).toHaveLength(0);

    // Still lands in the Payment Ledger -- the credit leg is unchanged from
    // the cash path (STR-023's "one posting, both projections").
    const paymentLedger = await getPaymentLedgerEntries(db);
    expect(paymentLedger).toHaveLength(1);
    expect(paymentLedger[0].account_id).toBe('member_dues');
    expect(paymentLedger[0].direction).toBe('credit');

    expect(result.amount).toBe('1250.00');
    expect(await countRows(db, 'journal_entries')).toBe(1);
    expect(await countRows(db, 'receipts')).toBe(1);
  });

  // T-U3 (first half): a charge that is already `paid` is rejected before
  // anything is written -- no second posting, no second receipt.
  it('rejects a payment against an already-paid charge with nothing written', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const chargeId = await seedDueCharge(db, '1250.00');

    await recordOfflinePayment(
      db,
      bucket,
      chargeId,
      { employeeId: 'emp-1' },
      { method: 'cash', amount: '1250.00', receivedOn: '2026-08-05' },
      randomUUID(),
    );

    await expect(
      recordOfflinePayment(
        db,
        bucket,
        chargeId,
        { employeeId: 'emp-1' },
        { method: 'cash', amount: '1250.00', receivedOn: '2026-08-06' },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(OfflinePaymentConflictError);

    expect(await countRows(db, 'journal_entries')).toBe(1);
    expect(await countRows(db, 'receipts')).toBe(1);
    expect(await countRows(db, 'offline_payments')).toBe(1);
  });

  // T-U3 (second half): replaying the same Idempotency-Key for an
  // already-recorded payment returns the identical result -- not a 409, and
  // with no second posting. The replay check therefore has to run before the
  // charge-status check, since the charge is `paid` by then.
  it('returns the identical result when the same Idempotency-Key is replayed', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const chargeId = await seedDueCharge(db, '1250.00');
    const idempotencyKey = randomUUID();
    const input = { method: 'cash' as const, amount: '1250.00', receivedOn: '2026-08-05' };

    const first = await recordOfflinePayment(db, bucket, chargeId, { employeeId: 'emp-1' }, input, idempotencyKey);
    const replay = await recordOfflinePayment(db, bucket, chargeId, { employeeId: 'emp-1' }, input, idempotencyKey);

    expect(replay).toEqual(first);
    expect(await countRows(db, 'journal_entries')).toBe(1);
    expect(await countRows(db, 'receipts')).toBe(1);
    expect(await countRows(db, 'offline_payments')).toBe(1);
  });
});
