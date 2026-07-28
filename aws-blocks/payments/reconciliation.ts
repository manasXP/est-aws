// STR-096: reconciliation of lingering payment intents -- closes E10's own
// named "double settlement across paths" risk. A webhook that is lost,
// delayed, or never delivered leaves an intent stuck `pending` with its
// charges locked `in_payment` indefinitely; this sweeps those up and asks the
// provider what actually happened.
//
// It deliberately implements NO settlement logic of its own: a definitive
// provider answer is handed straight to STR-094's own settleSuccessfulPayment
// / settleFailedPayment (exported for exactly this), so there is one posting
// path in the codebase, not two. The intent row is locked `FOR UPDATE` and
// re-checked for a terminal status inside that lock, which is what makes
// reconciliation and a webhook racing on the same intent safe in either
// order: whichever transaction commits first settles, the other sees the
// terminal status and does nothing.
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket } from '@aws-blocks/blocks';
import type { PaymentProvider } from './payment-provider';
import { settleSuccessfulPayment, settleFailedPayment } from './webhook-settlement';
import type { LockedPaymentIntent } from './webhook-settlement';
import { pgTextArray } from '../sql-array';

/** `payment_intents.status` (migrations/029_payment_intents.sql) has no
 * `in_payment` value -- that is the *charges* status. The two non-terminal
 * intent statuses are `initiated` and `pending`; only `pending` is ever
 * written today (see payment-initiation.ts), but a stuck `initiated` row
 * would be just as lingering, so the sweep covers both. */
const AWAITING_SETTLEMENT_STATUSES = ['initiated', 'pending'];

/** What reconciliation records as the failure reason -- the provider's status
 * lookup (STR-091's ProviderIntentStatus) reports no reason of its own, only
 * `failed`, so this names the source instead of inventing a cause. */
const RECONCILED_FAILURE_REASON = 'Reported failed by the payment provider during reconciliation.';

export interface LingeringIntent {
  paymentIntentId: string;
  providerIntentId: string;
}

interface LingeringIntentRow {
  id: string;
  provider_intent_id: string;
}

/**
 * The intents a lost or delayed webhook would leave behind: still awaiting
 * settlement and not touched for longer than `staleAfterMinutes`. Already
 * settled (`succeeded`/`failed`) intents are excluded by the status filter,
 * so a settled intent is never swept again however old it gets. Oldest first,
 * so the longest-stuck member charge is unlocked first.
 */
export async function findLingeringIntents(db: Database, staleAfterMinutes: number): Promise<LingeringIntent[]> {
  const rows = await db.query<LingeringIntentRow>(
    sql`SELECT id, provider_intent_id FROM payment_intents
        WHERE status = ANY(${pgTextArray(AWAITING_SETTLEMENT_STATUSES)}::text[])
          AND updated_at < now() - (${staleAfterMinutes} * INTERVAL '1 minute')
        ORDER BY updated_at`,
  );
  return rows.map(row => ({ paymentIntentId: row.id, providerIntentId: row.provider_intent_id }));
}

interface LockedIntentRow {
  id: string;
  member_id: string;
  charge_ids: string[];
  amount: string;
  status: string;
}

/**
 * Reconciles one intent against the provider's own record. The status lookup
 * runs *before* the transaction is opened -- a provider round-trip is network
 * I/O and must never be held across a row lock. A non-definitive answer
 * (`created`: still in flight, or the provider having no record of it yet --
 * ProviderIntentStatus has no separate not-found state) writes nothing at
 * all, leaving the intent for a later sweep.
 *
 * A lookup failure propagates: the AsyncJob wiring in aws-blocks/index.ts
 * leaves `maxRetries` at its framework default so a transient provider
 * outage retries and only then lands in the DLQ, per intent rather than
 * failing a whole batch.
 */
export async function reconcileIntent(
  db: Database,
  bucket: FileBucket,
  provider: PaymentProvider,
  paymentIntentId: string,
): Promise<void> {
  const lookup = await db.queryOne<{ provider_intent_id: string }>(
    sql`SELECT provider_intent_id FROM payment_intents WHERE id = ${paymentIntentId}`,
  );
  if (!lookup) return;

  const { status } = await provider.getIntentStatus(lookup.provider_intent_id);
  if (status !== 'paid' && status !== 'failed') return;

  await db.transaction(async tx => {
    const row = await tx.queryOne<LockedIntentRow>(
      sql`SELECT id, member_id, charge_ids, amount::text AS amount, status
          FROM payment_intents WHERE id = ${paymentIntentId} FOR UPDATE`,
    );
    // Settled by the webhook between the sweep and this lock -- do nothing.
    if (!row || !AWAITING_SETTLEMENT_STATUSES.includes(row.status)) return;

    const intent: LockedPaymentIntent = {
      id: row.id,
      memberId: row.member_id,
      chargeIds: row.charge_ids,
      amount: row.amount,
    };
    if (status === 'paid') {
      // The intent's own amount: a status lookup reports no amount to check
      // it against (unlike a webhook, which carries one), so there is nothing
      // here for settleSuccessfulPayment's mismatch guard to catch. An
      // amount-mismatched payment is still caught on the webhook path, which
      // flags it for a human rather than posting.
      await settleSuccessfulPayment(tx, bucket, intent, { amount: row.amount });
    } else {
      await settleFailedPayment(tx, intent, { failureReason: RECONCILED_FAILURE_REASON });
    }
  });
}
