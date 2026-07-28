// STR-094: signed idempotent webhook settlement -- the epic's own named top
// risk (E10, Risks: "an unsigned/replayed webhook marking charges paid is
// direct financial loss"). Settles a payment_intents row only from a
// signature-verified, idempotently-processed provider webhook, atomically:
// posting, charge-status flip, and receipt issuance all happen inside one
// caller-owned db.transaction() (via STR-021's postJournalEntryTx and
// STR-079's issueReceiptTx, both extracted for exactly this composition),
// so a failure anywhere leaves no partial posting, no orphaned receipt, and
// no charge-status drift.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket, Transaction } from '@aws-blocks/blocks';
import type { PaymentProvider, WebhookEvent } from './payment-provider';
import { postJournalEntryTx } from '../finance/journal';
import { issueReceiptTx } from '../finance/receipts';
import { moneyEquals } from '../money';
import { pgTextArray } from '../sql-array';

/** Thrown when `provider.verifyWebhookSignature` returns false -- nothing is
 * read or written when this is thrown (T-U3): checked before any database
 * access at all. */
export class InvalidWebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature.') {
    super(message);
    this.name = 'InvalidWebhookSignatureError';
  }
}

/** Thrown when a genuinely new (not a replay) webhook names a providerIntentId
 * with no matching payment_intents row -- shouldn't happen for a real webhook
 * about an intent this system created, but this is a clear, named error
 * rather than a bare/unclear crash. Nothing is written when this is thrown. */
export class UnknownPaymentIntentError extends Error {
  constructor(providerIntentId: string) {
    super(`No payment intent found for provider intent id: ${providerIntentId}`);
    this.name = 'UnknownPaymentIntentError';
  }
}

/** The locked payment_intents row shape the settlement branches below need --
 * exported so STR-096 (reconciliation) can synthesize the same shape from a
 * different source (not necessarily a live webhook) and call the same
 * settlement functions directly. */
export interface LockedPaymentIntent {
  id: string;
  memberId: string;
  chargeIds: string[];
  /** Decimal string (aws-blocks/money.ts convention). */
  amount: string;
}

/**
 * Success-branch settlement: if `event.amount` matches `intent.amount`
 * exactly (decimal-string comparison, never a float), posts one balanced
 * journal entry (bank debit / member_dues credit, tagged for the Payment
 * Ledger projection), flips every named charge to `paid`, issues a receipt,
 * and marks the intent `succeeded` -- all against the caller's own `tx`. If
 * the amounts don't match, posts and pays nothing -- just flags the intent
 * for reconciliation (no partial payments in v1; the gateway payment likely
 * did happen, just for the wrong total, so this is left for STR-096 or a
 * human to resolve, never silently marked paid or part-paid).
 *
 * Takes only its own parameters -- no closure over anything not passed in --
 * so STR-096 can call this directly with a synthesized `intent`/`event`.
 */
export async function settleSuccessfulPayment(
  tx: Transaction,
  bucket: FileBucket,
  intent: LockedPaymentIntent,
  event: Pick<WebhookEvent, 'amount'>,
): Promise<void> {
  if (!moneyEquals(event.amount, intent.amount)) {
    await tx.execute(sql`UPDATE payment_intents SET flagged_for_reconciliation = true WHERE id = ${intent.id}`);
    return;
  }

  const { entryId } = await postJournalEntryTx(tx, 'Payment received', [
    { accountId: 'bank', direction: 'debit', amount: intent.amount },
    { accountId: 'member_dues', direction: 'credit', amount: intent.amount, counterpartyType: 'member', counterpartyId: intent.memberId },
  ]);
  await tx.execute(
    sql`UPDATE charges SET status = 'paid', updated_at = now() WHERE id = ANY(${pgTextArray(intent.chargeIds)}::text[])`,
  );
  await issueReceiptTx(tx, bucket, entryId, intent.amount);
  await tx.execute(sql`UPDATE payment_intents SET status = 'succeeded', updated_at = now() WHERE id = ${intent.id}`);
}

/**
 * Failure-branch settlement: marks the intent `failed` with the reported
 * reason and reverts every named charge from `in_payment` back to `due` --
 * no posting, no receipt. Takes only its own parameters -- no closure over
 * anything not passed in -- so STR-096 can call this directly with a
 * synthesized `intent`/`event`.
 */
export async function settleFailedPayment(
  tx: Transaction,
  intent: LockedPaymentIntent,
  event: Pick<WebhookEvent, 'failureReason'>,
): Promise<void> {
  await tx.execute(
    sql`UPDATE payment_intents SET status = 'failed', failure_reason = ${event.failureReason ?? null} WHERE id = ${intent.id}`,
  );
  await tx.execute(
    sql`UPDATE charges SET status = 'due', updated_at = now() WHERE id = ANY(${pgTextArray(intent.chargeIds)}::text[])`,
  );
}

interface PaymentIntentRow {
  id: string;
  member_id: string;
  charge_ids: string[];
  amount: string;
  status: string;
}

/**
 * Settles a payment_intents row from a raw provider webhook delivery.
 * `provider.verifyWebhookSignature` runs FIRST, before any database access at
 * all (T-U3) -- a false result throws `InvalidWebhookSignatureError`
 * immediately, genuinely before `db` is ever touched. Only then is the event
 * parsed and one `db.transaction()` opened: the delivery is recorded
 * idempotently (`webhook_events.provider_event_id` UNIQUE, keyed on
 * `type:eventId` -- see the review-fix comment below for why -- same
 * insert-if-absent idiom as aws-blocks/payments/charges.ts's
 * insertChargeIfAbsent) -- a duplicate delivery (T-U2) returns immediately,
 * nothing else runs -- then the named payment_intents row is locked `FOR
 * UPDATE` and dispatched three ways: `payment.captured` settles success,
 * `payment.failed` settles failure, and any other event type is a no-op
 * (nothing on payment_intents/charges changes) -- the settling branches
 * composed into this same open transaction so a failure anywhere leaves
 * nothing partially written.
 */
export async function settleWebhookEvent(
  db: Database,
  bucket: FileBucket,
  provider: PaymentProvider,
  rawBody: string,
  signatureHeader: string,
): Promise<void> {
  const valid = await provider.verifyWebhookSignature(rawBody, signatureHeader);
  if (!valid) {
    throw new InvalidWebhookSignatureError();
  }

  const event = provider.parseWebhookEvent(rawBody);

  // STR-094 review fix: Razorpay commonly delivers both a `payment.authorized`
  // and a `payment.captured` webhook for the same underlying payment, and
  // razorpay-adapter.ts's parseWebhookEvent derives `eventId` from the
  // payment entity's own id -- the SAME id for both deliveries (there's no
  // separate top-level delivery id to use instead). Deduping on `eventId`
  // alone would make the harmless `payment.authorized` no-op "use up" the
  // dedup slot the real `payment.captured` settlement later needs, silently
  // dropping the actual success. Deduping on `type` alone would fail T-U2 (a
  // truly replayed identical webhook must still be a no-op). Keying
  // `provider_event_id` on `type:eventId` together satisfies both: a genuine
  // replay (same type, same eventId) still collides and is dropped, while an
  // authorized/captured pair for the same payment (same eventId, different
  // type) gets two distinct rows and is processed independently.
  const idempotencyKey = `${event.type}:${event.eventId}`;

  await db.transaction(async tx => {
    const inserted = await tx.execute(
      sql`INSERT INTO webhook_events (id, provider, provider_event_id) VALUES (${randomUUID()}, 'razorpay', ${idempotencyKey})
          ON CONFLICT (provider_event_id) DO NOTHING`,
    );
    if (inserted.rowCount === 0) {
      return; // Already processed (T-U2) -- nothing else runs.
    }

    const row = await tx.queryOne<PaymentIntentRow>(
      sql`SELECT id, member_id, charge_ids, amount::text AS amount, status FROM payment_intents WHERE provider_intent_id = ${event.providerIntentId} FOR UPDATE`,
    );
    if (!row) {
      throw new UnknownPaymentIntentError(event.providerIntentId);
    }
    // STR-096: event-level dedup above only stops a *replay* of the same
    // delivery. It cannot stop a genuine first-time webhook for an intent
    // STR-096's reconciliation job already settled -- that webhook carries a
    // never-seen event id, so it would sail past the dedup and post a second
    // journal entry and receipt for one payment. Terminal status, re-read
    // under this same FOR UPDATE lock, is the per-intent guard that makes
    // settlement idempotent across *both* paths in either order (E10's
    // "double settlement across paths" risk).
    if (row.status === 'succeeded' || row.status === 'failed') {
      return;
    }
    const intent: LockedPaymentIntent = { id: row.id, memberId: row.member_id, chargeIds: row.charge_ids, amount: row.amount };

    if (event.type === 'payment.captured') {
      await settleSuccessfulPayment(tx, bucket, intent, event);
    } else if (event.type === 'payment.failed') {
      await settleFailedPayment(tx, intent, event);
    }
    // else: any other event type (e.g. `payment.authorized`, refund/dispute/
    // order events) is a no-op settlement -- the webhook_events row above
    // already recorded it for audit/idempotency, but nothing on
    // payment_intents/charges changes.
  });
}
