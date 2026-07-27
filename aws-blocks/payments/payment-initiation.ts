// STR-092: payment initiation with idempotent charge locking -- sits between
// the `charges` table (aws-blocks/payments/charges.ts, STR-061/STR-065) and
// the new `payment_intents` table this story creates (migrations/
// 029_payment_intents.sql). Mirrors aws-blocks/vendors/work-orders.ts's
// style: plain exported functions over a Database, one db.transaction() per
// write, no HTTP concerns (the `POST /v1/me/payments` RawRoute in
// aws-blocks/index.ts is a thin adapter over initiatePayment below).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import type { PaymentProvider } from './payment-provider';
import { sumMoney, formatMoney, parseMoney } from '../money';
import { pgTextArray } from '../sql-array';
import { computeConvenienceFee, type PaymentMethod } from './convenience-fee';

// The Mobile Public API's PaymentIntent.provider is a fixed gateway
// identifier ("razorpay (decided 2026-07-20)"), not a per-call choice --
// this repo has exactly one PaymentProvider wired at a time (aws-blocks/
// index.ts), so there's no per-request provider selection to thread through.
const PROVIDER_NAME = 'razorpay';

/** Domain rejection for a payment initiation naming a charge that doesn't
 * exist or isn't owned by the caller -- nothing is written when this is
 * thrown (T-U4). Deliberately the same message regardless of which of those
 * two reasons applies, so no response ever leaks whether a charge_id exists
 * or who owns it (T-U4). Maps to the Mobile API's 422 "Unknown charge id, or
 * charge not owned by this member." */
export class ChargeNotPayableError extends Error {
  constructor(message = 'One or more of the specified charges is not payable.') {
    super(message);
    this.name = 'ChargeNotPayableError';
  }
}

/** Domain rejection for a payment initiation naming a charge that exists and
 * is owned by the caller, but isn't `due` (already `paid`, or `in_payment`
 * under another payment) -- nothing is written when this is thrown (T-U3).
 * Maps to the Mobile API's 409 "A charge is not payable (already paid, or
 * in-flight under another payment)." -- distinct from ChargeNotPayableError's
 * 422, per the OpenAPI spec's two separate error responses for this
 * endpoint. */
export class ChargeAlreadyLockedError extends Error {
  constructor(message = 'One or more of the specified charges is already paid or in-flight under another payment.') {
    super(message);
    this.name = 'ChargeAlreadyLockedError';
  }
}

export interface PaymentIntentResult {
  paymentId: string;
  provider: string;
  providerParams: Record<string, unknown>;
  amount: string;
}

interface PaymentIntentRow {
  id: string;
  provider: string;
  provider_params: string;
  amount: string;
}

function toResult(row: PaymentIntentRow): PaymentIntentResult {
  return {
    paymentId: row.id,
    provider: row.provider,
    providerParams: JSON.parse(row.provider_params),
    amount: formatMoney(parseMoney(row.amount)),
  };
}

/** Reads the existing `(member_id, idempotency_key)` row, if any -- shared by
 * initiatePayment's pre-transaction check (step 1) and its in-transaction
 * race re-check (step 2b/2d) below. Takes a Database or a Transaction, since
 * both expose the same `queryOne`. */
async function findExistingIntent(
  dbOrTx: Database | Transaction,
  memberId: string,
  idempotencyKey: string,
): Promise<PaymentIntentResult | null> {
  const row = await dbOrTx.queryOne<PaymentIntentRow>(
    sql`SELECT id, provider, provider_params, amount::text AS amount
        FROM payment_intents
        WHERE member_id = ${memberId} AND idempotency_key = ${idempotencyKey}`,
  );
  return row ? toResult(row) : null;
}

/**
 * Locks the named charges `FOR UPDATE`, scoped to `memberId`, and validates
 * that every named charge exists, belongs to the caller, and is `due` --
 * extracted as its own step (STR-092's Refactor note) so STR-093 can insert
 * fee computation between locking and calling `provider.createIntent`
 * without touching the locking logic itself. Distinguishes two failure
 * buckets (T-U3/T-U4, matching the OpenAPI spec's two distinct error
 * responses for this endpoint):
 *   - any named chargeId missing from `locked` entirely (doesn't exist, or
 *     isn't owned by memberId) -> `ChargeNotPayableError` (422); checked
 *     first, so a request naming both an unknown/foreign charge and an
 *     already-locked one is treated as malformed (422) rather than a state
 *     conflict (409).
 *   - every named chargeId present in `locked`, but at least one isn't
 *     `due` -> `ChargeAlreadyLockedError` (409).
 * Writes nothing in either case; the caller is responsible for the T-U5
 * race re-check before treating either as a genuine conflict.
 */
async function lockChargesForPayment(
  tx: Transaction,
  memberId: string,
  chargeIds: string[],
): Promise<{ id: string; amount: string }[]> {
  const locked = await tx.query<{ id: string; amount: string; status: string }>(
    sql`SELECT id, amount::text AS amount, status
        FROM charges
        WHERE id = ANY(${pgTextArray(chargeIds)}::text[]) AND member_id = ${memberId}
        FOR UPDATE`,
  );

  const lockedIds = new Set(locked.map(charge => charge.id));
  if (chargeIds.some(id => !lockedIds.has(id))) {
    throw new ChargeNotPayableError();
  }
  if (locked.some(charge => charge.status !== 'due')) {
    throw new ChargeAlreadyLockedError();
  }

  return locked.map(charge => ({ id: charge.id, amount: charge.amount }));
}

/**
 * `POST /v1/me/payments` business logic (Payments spec's decided rules: no
 * partial payments, a charge already `paid`/`in_payment` cannot be
 * re-initiated). First checks for an existing `(member_id, idempotency_key)`
 * row and returns it unchanged if found (T-U2); else, inside one
 * `db.transaction()`, locks and validates the named charges (T-U3/T-U4),
 * sums their amounts via `sumMoney` (always an exact decimal string, never a
 * float), calls `provider.createIntent`, flips the charges to `in_payment`,
 * and inserts the `payment_intents` row.
 *
 * T-U5: two concurrent requests carrying the *same* idempotency key both try
 * to `FOR UPDATE` lock the same charge rows -- the second blocks until the
 * first commits, and by the time it's unblocked the charges already show
 * `status = 'in_payment'` (flipped by the winning request), so
 * lockChargesForPayment throws `ChargeAlreadyLockedError`. That's not a real
 * conflict, it's this request's own twin having already won the race, so
 * lockChargesForPayment's failure -- whether `ChargeNotPayableError` or
 * `ChargeAlreadyLockedError` -- is re-checked here against `payment_intents`
 * before being treated as a genuine failure -- if a matching row now exists,
 * it's returned instead.
 *
 * The INSERT itself uses `ON CONFLICT (member_id, idempotency_key) DO
 * NOTHING ... RETURNING` rather than a plain INSERT wrapped in a try/catch
 * for the unique-constraint violation (the shape aws-blocks/finance/
 * documents.ts's linkDocumentToEntry uses for `already_linked`): this
 * repo's local `@aws-blocks/bb-data` PGlite mock runs everything over a
 * single shared connection (see test/finance/receipts.test.ts's T-P1
 * comment), so two "concurrent" `db.transaction()` calls merge into one
 * open transaction rather than two truly isolated Postgres sessions -- a
 * real constraint-violation error there poisons that one shared
 * transaction, and the recovery re-SELECT (run against the now-poisoned
 * transaction) can't see the very row that just lost. `ON CONFLICT ... DO
 * NOTHING` sidesteps this entirely: it is not an error condition in
 * Postgres at all (same idiom charges.ts's insertChargeIfAbsent already
 * uses), so nothing gets poisoned regardless of whether the two calls are
 * really isolated (production) or merged into one connection (this local
 * mock) -- correct under both.
 */
export async function initiatePayment(
  db: Database,
  provider: PaymentProvider,
  memberId: string,
  chargeIds: string[],
  paymentMethod: PaymentMethod,
  idempotencyKey: string,
): Promise<PaymentIntentResult> {
  const existing = await findExistingIntent(db, memberId, idempotencyKey);
  if (existing) return existing;

  return db.transaction(async tx => {
    let lockedCharges;
    try {
      lockedCharges = await lockChargesForPayment(tx, memberId, chargeIds);
    } catch (e) {
      if (e instanceof ChargeNotPayableError || e instanceof ChargeAlreadyLockedError) {
        const raced = await findExistingIntent(tx, memberId, idempotencyKey);
        if (raced) return raced;
      }
      throw e;
    }

    const baseAmount = sumMoney(lockedCharges.map(charge => charge.amount));
    // STR-093: itemizes the card/netbanking convenience fee (never charged on
    // UPI) between locking the charges and calling the provider -- the
    // fee-inclusive total is what the gateway is asked to charge, and what
    // this row's `amount` column and the returned PaymentIntentResult.amount
    // represent (the Mobile OpenAPI's PaymentIntent has no separate fee
    // field; `convenience_fee` below is stored for audit/reconciliation only).
    const { fee, totalAmount } = await computeConvenienceFee(tx, paymentMethod, baseAmount);
    const { providerIntentId, providerParams } = await provider.createIntent({ amount: totalAmount });

    await tx.execute(
      sql`UPDATE charges SET status = 'in_payment', updated_at = now() WHERE id = ANY(${pgTextArray(chargeIds)}::text[])`,
    );

    const id = randomUUID();
    // STR-093: written as 'pending', not STR-092's original 'initiated' --
    // by the time this row exists at all, provider.createIntent above has
    // already synchronously created a real provider intent, so there is no
    // observable window in this flow where 'initiated' is the correct
    // externally-visible state (T-U3: every poll before a webhook arrives
    // must show 'pending'). 'initiated' stays a valid CHECK value for schema
    // completeness/future use; this code path just never writes it.
    const insertedRow = await tx.queryOne<PaymentIntentRow>(
      sql`INSERT INTO payment_intents (id, idempotency_key, member_id, charge_ids, amount, status, provider, provider_intent_id, provider_params, payment_method, convenience_fee)
          VALUES (${id}, ${idempotencyKey}, ${memberId}, ${pgTextArray(chargeIds)}::text[], ${totalAmount}::numeric, 'pending', ${PROVIDER_NAME}, ${providerIntentId}, ${JSON.stringify(providerParams)}, ${paymentMethod}, ${fee}::numeric)
          ON CONFLICT (member_id, idempotency_key) DO NOTHING
          RETURNING id, provider, provider_params, amount::text AS amount`,
    );
    if (insertedRow) {
      return toResult(insertedRow);
    }

    // Lost the race -- a concurrent request with the same idempotency key
    // already inserted its row (T-U5). Return it instead of erroring.
    const raced = await findExistingIntent(tx, memberId, idempotencyKey);
    if (raced) return raced;
    throw new Error(`payment_intents insert conflicted, but no existing row was found for idempotency key ${idempotencyKey}.`);
  });
}

export interface PaymentStatusResult {
  paymentId: string;
  amount: string;
  status: string;
  chargeIds: string[];
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

/**
 * `GET /v1/me/payments/{paymentId}` business logic -- a plain read scoped to
 * the caller's own `member_id` (returns `null`, not a leak-prone distinction,
 * for both "doesn't exist" and "exists but belongs to someone else", the
 * same identical-rejection posture initiatePayment's ChargeNotPayableError
 * established). `completed_at`/`failure_reason` don't exist as columns yet
 * -- this story's initiatePayment only ever writes `status = 'pending'`, so
 * they're always null; STR-094's webhook-settlement migration adds the real
 * columns and this mapping will pick them up then.
 */
export async function getPaymentStatus(db: Database, memberId: string, paymentId: string): Promise<PaymentStatusResult | null> {
  const row = await db.queryOne<{ id: string; amount: string; status: string; charge_ids: string[]; created_at: string }>(
    sql`SELECT id, amount::text AS amount, status, charge_ids, created_at::text AS created_at
        FROM payment_intents
        WHERE id = ${paymentId} AND member_id = ${memberId}`,
  );
  if (!row) return null;
  return {
    paymentId: row.id,
    amount: formatMoney(parseMoney(row.amount)),
    status: row.status,
    chargeIds: row.charge_ids,
    createdAt: row.created_at,
    completedAt: null,
    failureReason: null,
  };
}
