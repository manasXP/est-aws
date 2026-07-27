import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { settleWebhookEvent, InvalidWebhookSignatureError } from '../../aws-blocks/payments/webhook-settlement';
import { initiatePayment } from '../../aws-blocks/payments/payment-initiation';
import { FakePaymentProvider } from '../../aws-blocks/payments/fake-payment-provider';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-094 -- signed idempotent webhook settlement. Unit-level (BE-U): every
// case is exercised directly against settleWebhookEvent, not through the
// HTTP RawRoute (no contract test required for this story). Follows the
// STR-092 test pattern (test/payments/payment-initiation.test.ts): fresh
// Database + Scope + FileBucket per test, real payment_intents/charges rows
// seeded via initiatePayment.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-094-webhook-settlement-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-094-test-${randomUUID()}`), 'documents');
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

async function seedReceiptPrefix(db: Database, prefix: string): Promise<void> {
  await db.execute(sql`UPDATE society_settings SET receipt_prefix = ${prefix} WHERE id = 'default'`);
}

async function seedMemberWithOwnership(db: Database): Promise<{ memberId: string; ownershipId: string }> {
  const project = await createProject(db, { name: 'Green Meadows' });
  const member = await createMember(db, { name: 'Asha Rao' });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  return { memberId: member.member_id, ownershipId: ownership.ownership_id };
}

/** Tests seed a charge directly via SQL -- there is no charge-creation HTTP
 * endpoint, same as test/payments/payment-initiation.test.ts's own
 * seedCharge helper. */
async function seedCharge(db: Database, memberId: string, ownershipId: string, amount = '1250.00'): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${memberId}, ${ownershipId}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

/** Sets up a real in_payment intent + locked charge via initiatePayment (the
 * genuine STR-092/093 path), and returns everything a webhook test needs to
 * settle it. */
async function seedInPaymentIntent(
  db: Database,
  provider: FakePaymentProvider,
  amount = '1250.00',
): Promise<{ memberId: string; chargeId: string; providerIntentId: string; amount: string }> {
  const { memberId, ownershipId } = await seedMemberWithOwnership(db);
  const chargeId = await seedCharge(db, memberId, ownershipId, amount);
  const result = await initiatePayment(db, provider, memberId, [chargeId], 'upi', randomUUID());
  const providerIntentId = provider.createdIntents[provider.createdIntents.length - 1].providerIntentId;
  return { memberId, chargeId, providerIntentId, amount: result.amount };
}

describe('STR-094 settleWebhookEvent', () => {
  // T-U1 (covers TC-PAY-040): a valid signed success webhook settles the
  // intent, pays the charge, posts exactly one journal entry touching the
  // Bank Book and the Payment Ledger, and issues a receipt.
  it('settles succeeded, pays charges, posts one balanced entry, and issues a receipt', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { memberId, chargeId, providerIntentId, amount } = await seedInPaymentIntent(db, provider);

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId,
      amount,
    });

    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    const intent = await db.queryOne<{ status: string }>(
      sql`SELECT status FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
    );
    expect(intent!.status).toBe('succeeded');

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('paid');

    const entries = await db.query<{ id: string }>(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(1);
    const entryId = entries[0].id;

    const lines = await db.query<{
      direction: string;
      amount: string;
      kind: string;
      counterparty_type: string | null;
      counterparty_id: string | null;
    }>(
      sql`SELECT jl.direction, jl.amount::text AS amount, la.kind, jl.counterparty_type, jl.counterparty_id
          FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.account_id
          WHERE jl.entry_id = ${entryId}`,
    );
    expect(lines).toHaveLength(2);
    const debit = lines.find(l => l.direction === 'debit');
    const credit = lines.find(l => l.direction === 'credit');
    expect(debit!.kind).toBe('bank');
    expect(debit!.amount).toBe(amount);
    expect(credit!.counterparty_type).toBe('member');
    expect(credit!.counterparty_id).toBe(memberId);
    expect(credit!.amount).toBe(amount);

    const receipts = await db.query<{ id: string }>(sql`SELECT id FROM receipts WHERE entry_id = ${entryId}`);
    expect(receipts).toHaveLength(1);
  });

  // T-U2 (covers TC-PAY-041): the identical webhook (same eventId) delivered
  // twice is a no-op the second time -- exactly one posting and one receipt.
  it('is a no-op the second time the identical webhook event is delivered', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { providerIntentId, amount } = await seedInPaymentIntent(db, provider);

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId,
      amount,
    });

    await settleWebhookEvent(db, bucket, provider, rawBody, signature);
    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(1);
    const receipts = await db.query(sql`SELECT id FROM receipts`);
    expect(receipts).toHaveLength(1);
  });

  // T-U3 (covers TC-PAY-042): an invalid signature is rejected before any
  // database access at all -- proven with a Database double whose every
  // method throws if called.
  it('rejects an invalid signature before touching the database at all', async () => {
    const throwOnCall = () => {
      throw new Error('Database must not be touched before signature verification.');
    };
    const throwingDb = {
      query: throwOnCall,
      queryOne: throwOnCall,
      execute: throwOnCall,
      transaction: throwOnCall,
    } as unknown as Database;
    const bucket = freshBucket();
    const provider = new FakePaymentProvider();

    const { rawBody } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId: 'fake-intent-1',
      amount: '1250.00',
    });
    const tamperedSignature = 'deadbeef';

    await expect(settleWebhookEvent(throwingDb, bucket, provider, rawBody, tamperedSignature)).rejects.toThrow(
      InvalidWebhookSignatureError,
    );
  });

  // T-U4 (covers TC-PAY-044): a valid signed failure webhook sets the
  // intent failed + failure_reason, reverts charges to due, posts nothing.
  it('reverts charges to due and sets failed + failure_reason on a failure webhook, with no posting', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { chargeId, providerIntentId, amount } = await seedInPaymentIntent(db, provider);

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.failed',
      eventId: randomUUID(),
      providerIntentId,
      amount,
      failureReason: 'insufficient funds',
    });

    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    const intent = await db.queryOne<{ status: string; failure_reason: string | null }>(
      sql`SELECT status, failure_reason FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
    );
    expect(intent!.status).toBe('failed');
    expect(intent!.failure_reason).toBe('insufficient funds');

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('due');

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(0);
    const receipts = await db.query(sql`SELECT id FROM receipts`);
    expect(receipts).toHaveLength(0);
  });

  // T-U5 (covers TC-PAY-045): a success webhook whose reported amount
  // differs from the intent's total is rejected for reconciliation -- no
  // posting, no receipt, the intent stays as-is (not failed, not paid), and
  // flagged_for_reconciliation is true.
  it('flags an amount-mismatched success webhook for reconciliation instead of posting', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { chargeId, providerIntentId } = await seedInPaymentIntent(db, provider, '1250.00');

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId,
      amount: '999.00', // differs from the intent's stored total
    });

    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    const intent = await db.queryOne<{ status: string; flagged_for_reconciliation: boolean }>(
      sql`SELECT status, flagged_for_reconciliation FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
    );
    expect(intent!.status).not.toBe('succeeded');
    expect(intent!.status).not.toBe('failed');
    expect(intent!.flagged_for_reconciliation).toBe(true);

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('in_payment');

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(0);
    const receipts = await db.query(sql`SELECT id FROM receipts`);
    expect(receipts).toHaveLength(0);
  });

  // Review fix regression: an event type that is neither `payment.captured`
  // nor `payment.failed` (e.g. `payment.authorized`) must be a true no-op --
  // not silently treated as a failure. Before the fix, the binary if/else
  // dispatch fell into the failure branch for ANY non-`payment.captured`
  // type, reverting charges and failing the intent for what is really just
  // an informational event.
  it('is a no-op for an unrecognized event type like payment.authorized, leaving the intent and charges untouched', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { chargeId, providerIntentId, amount } = await seedInPaymentIntent(db, provider);

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.authorized',
      eventId: randomUUID(),
      providerIntentId,
      amount,
    });

    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    const intent = await db.queryOne<{ status: string }>(
      sql`SELECT status FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
    );
    expect(intent!.status).toBe('pending');

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('in_payment');

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(0);
    const receipts = await db.query(sql`SELECT id FROM receipts`);
    expect(receipts).toHaveLength(0);
  });

  // Review fix regression: the reviewer's exact traced scenario -- Razorpay
  // delivers a `payment.authorized` webhook first, then a `payment.captured`
  // webhook for the same underlying payment, both carrying the SAME eventId
  // (razorpay-adapter.ts derives eventId from the payment entity's own id,
  // which is identical across both deliveries for one payment). The
  // authorized event must be a no-op (proven above) WITHOUT "using up" the
  // idempotency slot the later captured event needs -- otherwise the
  // dedup-by-eventId-alone check would wrongly treat the captured event as
  // an already-processed duplicate and the payment would never actually
  // settle. This is why the idempotency key is `type:eventId`, not just
  // `eventId`.
  it('settles a payment.captured webhook that follows a payment.authorized webhook sharing the same eventId', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new FakePaymentProvider();
    const { memberId, chargeId, providerIntentId, amount } = await seedInPaymentIntent(db, provider);
    const sharedEventId = randomUUID();

    const authorized = provider.buildSignedWebhook({
      type: 'payment.authorized',
      eventId: sharedEventId,
      providerIntentId,
      amount,
    });
    await settleWebhookEvent(db, bucket, provider, authorized.rawBody, authorized.signature);

    const captured = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: sharedEventId,
      providerIntentId,
      amount,
    });
    await settleWebhookEvent(db, bucket, provider, captured.rawBody, captured.signature);

    const intent = await db.queryOne<{ status: string }>(
      sql`SELECT status FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
    );
    expect(intent!.status).toBe('succeeded');

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('paid');

    const entries = await db.query<{ id: string }>(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(1);

    const lines = await db.query<{ counterparty_id: string | null }>(
      sql`SELECT counterparty_id FROM journal_lines WHERE entry_id = ${entries[0].id} AND direction = 'credit'`,
    );
    expect(lines[0].counterparty_id).toBe(memberId);

    const receipts = await db.query(sql`SELECT id FROM receipts`);
    expect(receipts).toHaveLength(1);
  });
});
