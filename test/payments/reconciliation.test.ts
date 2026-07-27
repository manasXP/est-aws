import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { findLingeringIntents, reconcileIntent } from '../../aws-blocks/payments/reconciliation';
import { settleWebhookEvent } from '../../aws-blocks/payments/webhook-settlement';
import { initiatePayment } from '../../aws-blocks/payments/payment-initiation';
import { FakePaymentProvider } from '../../aws-blocks/payments/fake-payment-provider';
import type { ProviderIntentStatus } from '../../aws-blocks/payments/payment-provider';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-096 -- reconciliation of lingering payment intents. Unit-level (BE-U):
// every case runs directly against findLingeringIntents/reconcileIntent, not
// through the CronJob/AsyncJob wiring in aws-blocks/index.ts (which, like
// STR-061's charge-run CronJob, is a one-line composition of the functions
// tested here). No TC-PAY case covers reconciliation -- the epic's exit
// criteria stop at TC-PAY-045/060/061 -- so every ID below is a genuine-gap
// T-U* ID, per the story's own Context note.
//
// Test setup follows STR-094 (test/payments/webhook-settlement.test.ts):
// fresh Database + Scope + FileBucket per test, real payment_intents/charges
// rows seeded through the genuine initiatePayment path.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

/** The fake provider's own getIntentStatus is a fixed `created` stub, so
 * reconciliation tests need one whose answer they control per intent. Kept
 * here rather than added to FakePaymentProvider: nothing outside these tests
 * needs to drive a provider's reported status. */
class StubStatusProvider extends FakePaymentProvider {
  private readonly reported = new Map<string, ProviderIntentStatus['status']>();

  reports(providerIntentId: string, status: ProviderIntentStatus['status']): void {
    this.reported.set(providerIntentId, status);
  }

  override async getIntentStatus(providerIntentId: string): Promise<ProviderIntentStatus> {
    // Default `created` doubles as "the provider has no definitive record of
    // this intent yet" -- ProviderIntentStatus (STR-091) has no separate
    // not-found state.
    return { status: this.reported.get(providerIntentId) ?? 'created' };
  }
}

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-096-reconciliation-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-096-test-${randomUUID()}`), 'documents');
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

async function seedCharge(db: Database, memberId: string, ownershipId: string, amount: string): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${memberId}, ${ownershipId}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

/** Seeds a real `pending` intent + `in_payment` charge through the genuine
 * STR-092/093 initiatePayment path -- the exact state a lost webhook leaves
 * behind. */
async function seedPendingIntent(
  db: Database,
  provider: FakePaymentProvider,
  amount = '1250.00',
): Promise<{ memberId: string; chargeId: string; paymentIntentId: string; providerIntentId: string; amount: string }> {
  const project = await createProject(db, { name: 'Green Meadows' });
  const member = await createMember(db, { name: 'Asha Rao' });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${randomUUID().slice(0, 4)}` });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  const chargeId = await seedCharge(db, member.member_id, ownership.ownership_id, amount);
  const result = await initiatePayment(db, provider, member.member_id, [chargeId], 'upi', randomUUID());
  const providerIntentId = provider.createdIntents[provider.createdIntents.length - 1].providerIntentId;
  const row = await db.queryOne<{ id: string }>(
    sql`SELECT id FROM payment_intents WHERE provider_intent_id = ${providerIntentId}`,
  );
  return {
    memberId: member.member_id,
    chargeId,
    paymentIntentId: row!.id,
    providerIntentId,
    amount: result.amount,
  };
}

/** Backdates an intent's `updated_at` so the sweep sees it as lingering --
 * the only way to age a row inside a single test run. */
async function ageIntent(db: Database, paymentIntentId: string, minutes: number): Promise<void> {
  await db.execute(
    sql`UPDATE payment_intents SET updated_at = now() - (${minutes} * INTERVAL '1 minute') WHERE id = ${paymentIntentId}`,
  );
}

describe('STR-096 findLingeringIntents', () => {
  // T-U1: the sweep picks up an intent still awaiting settlement past the
  // staleness threshold, and leaves one still within the threshold alone.
  it('returns only intents whose last update is older than the staleness threshold', async () => {
    const db = await freshMigratedDb();
    const provider = new StubStatusProvider();
    const stale = await seedPendingIntent(db, provider);
    const fresh = await seedPendingIntent(db, provider);
    await ageIntent(db, stale.paymentIntentId, 30);

    const lingering = await findLingeringIntents(db, 15);

    expect(lingering.map(i => i.paymentIntentId)).toEqual([stale.paymentIntentId]);
    expect(lingering[0].providerIntentId).toBe(stale.providerIntentId);
    expect(lingering.map(i => i.paymentIntentId)).not.toContain(fresh.paymentIntentId);
  });

  // T-U5 (gap beyond the story's Red list): an intent that already reached a
  // terminal state is never picked up, however old it is -- without this the
  // sweep would re-submit an AsyncJob for every settled intent on every run,
  // forever.
  it('never returns an already-settled intent, however stale', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new StubStatusProvider();
    const settled = await seedPendingIntent(db, provider);

    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId: settled.providerIntentId,
      amount: settled.amount,
    });
    await settleWebhookEvent(db, bucket, provider, rawBody, signature);
    await ageIntent(db, settled.paymentIntentId, 30);

    expect(await findLingeringIntents(db, 15)).toEqual([]);
  });
});

describe('STR-096 reconcileIntent', () => {
  // T-U2: the provider now reports the intent succeeded -- reconciliation
  // settles it through STR-094's own success path (one posting, one receipt,
  // charges paid), and the real webhook arriving afterwards for that same
  // intent is a no-op. The two paths can never double-settle one intent.
  it('settles a provider-confirmed success once, and the later webhook for the same intent is a no-op', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new StubStatusProvider();
    const { memberId, chargeId, paymentIntentId, providerIntentId, amount } = await seedPendingIntent(db, provider);
    provider.reports(providerIntentId, 'paid');

    await reconcileIntent(db, bucket, provider, paymentIntentId);

    const intent = await db.queryOne<{ status: string }>(
      sql`SELECT status FROM payment_intents WHERE id = ${paymentIntentId}`,
    );
    expect(intent!.status).toBe('succeeded');

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('paid');

    const entries = await db.query<{ id: string }>(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(1);
    const credit = await db.queryOne<{ counterparty_id: string | null; amount: string }>(
      sql`SELECT counterparty_id, amount::text AS amount FROM journal_lines WHERE entry_id = ${entries[0].id} AND direction = 'credit'`,
    );
    expect(credit!.counterparty_id).toBe(memberId);
    expect(credit!.amount).toBe(amount);
    expect(await db.query(sql`SELECT id FROM receipts`)).toHaveLength(1);

    // The genuine webhook -- a fresh, never-seen event id, so STR-094's
    // event-level dedup cannot be what stops it -- arrives after the fact.
    const { rawBody, signature } = provider.buildSignedWebhook({
      type: 'payment.captured',
      eventId: randomUUID(),
      providerIntentId,
      amount,
    });
    await settleWebhookEvent(db, bucket, provider, rawBody, signature);

    expect(await db.query(sql`SELECT id FROM journal_entries`)).toHaveLength(1);
    expect(await db.query(sql`SELECT id FROM receipts`)).toHaveLength(1);
  });

  // T-U3: the provider still reports the intent pending (or has no record of
  // it yet) -- nothing changes, so a later sweep can safely pick it up again.
  it('leaves an intent the provider has not settled yet completely untouched', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new StubStatusProvider();
    const { chargeId, paymentIntentId } = await seedPendingIntent(db, provider);
    // No `reports(...)` call: the provider answers `created`.

    await reconcileIntent(db, bucket, provider, paymentIntentId);

    const intent = await db.queryOne<{ status: string; failure_reason: string | null }>(
      sql`SELECT status, failure_reason FROM payment_intents WHERE id = ${paymentIntentId}`,
    );
    expect(intent!.status).toBe('pending');
    expect(intent!.failure_reason).toBeNull();

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('in_payment');

    expect(await db.query(sql`SELECT id FROM journal_entries`)).toHaveLength(0);
    expect(await db.query(sql`SELECT id FROM receipts`)).toHaveLength(0);
  });

  // T-U4: the provider reports the intent failed -- reconciliation settles it
  // through STR-094's own failure path: `failed` with a failure_reason,
  // charges back to `due`, no posting and no receipt.
  it('settles a provider-confirmed failure back to due with a failure reason and no posting', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await seedReceiptPrefix(db, 'SOC');
    const provider = new StubStatusProvider();
    const { chargeId, paymentIntentId, providerIntentId } = await seedPendingIntent(db, provider);
    provider.reports(providerIntentId, 'failed');

    await reconcileIntent(db, bucket, provider, paymentIntentId);

    const intent = await db.queryOne<{ status: string; failure_reason: string | null }>(
      sql`SELECT status, failure_reason FROM payment_intents WHERE id = ${paymentIntentId}`,
    );
    expect(intent!.status).toBe('failed');
    expect(intent!.failure_reason).toBeTruthy();

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('due');

    expect(await db.query(sql`SELECT id FROM journal_entries`)).toHaveLength(0);
    expect(await db.query(sql`SELECT id FROM receipts`)).toHaveLength(0);
  });
});
