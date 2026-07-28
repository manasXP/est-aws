// STR-095: offline (cash/cheque) payment recording -- the offline mirror of
// STR-094's gateway settlement path (Payments: "Offline payments (cash/cheque)
// are recorded by management and post to the Cash/Bank Book -- the ledgers
// must not assume all receipts come via the gateway"). The accounting shape
// is STR-094's, reused rather than re-derived: one balanced posting via
// STR-021's postJournalEntryTx (debit the collecting account, credit
// `member_dues` tagged `counterpartyType: 'member'` so STR-023's Payment
// Ledger projection picks it up), the charge flipped to `paid`, and one
// receipt via STR-079's issueReceiptTx -- all inside a single
// db.transaction(), so a failure anywhere leaves no partial posting, no
// orphaned receipt, and no charge-status drift.
//
// Only the debited account differs from the gateway path: cash debits the
// Cash Book's `cash` account, cheque debits the Bank Book's `bank` account
// (a cheque clears through the society's bank account, never cash-in-hand).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket, Transaction } from '@aws-blocks/blocks';
import { postJournalEntryTx } from '../finance/journal';
import { issueReceiptTx } from '../finance/receipts';
import { formatMoney, parseMoney, moneyEquals, InvalidMoneyError } from '../money';
import type { Actor } from '../members/capabilities';

/** The collection methods the Admin OpenAPI declares for this endpoint. */
export type OfflinePaymentMethod = 'cash' | 'cheque';

/**
 * Which ledger account each collection method debits. A cheque is *not*
 * cash-in-hand -- it clears through the society's bank account -- so it
 * debits the Bank Book, which is the single behavioural difference between
 * the two methods (AC2, TC-PAY-061).
 */
const DEBITED_ACCOUNT: Record<OfflinePaymentMethod, 'cash' | 'bank'> = {
  cash: 'cash',
  cheque: 'bank',
};

export interface RecordOfflinePaymentInput {
  method: OfflinePaymentMethod;
  amount: string;
  /** YYYY-MM-DD -- the date the money was actually collected. */
  receivedOn: string;
  /** Cheque number / memo. */
  reference?: string | null;
}

/** The issued receipt, in the shape the Admin OpenAPI's `Receipt` needs. */
export interface OfflinePaymentResult {
  receiptId: string;
  receiptNumber: string;
  /** Decimal string (aws-blocks/money.ts convention). */
  amount: string;
  issuedAt: string;
  chargeIds: string[];
}

/** Domain rejection mapped to `422 validation_error` -- nothing is written. */
export class OfflinePaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflinePaymentValidationError';
  }
}

/** Domain rejection mapped to `409 conflict` -- nothing is written. */
export class OfflinePaymentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflinePaymentConflictError';
  }
}

/** Same money-format-check idiom as vendors/invoice-payments.ts's own
 * assertValidMoney -- translates parseMoney's InvalidMoneyError into this
 * module's validation error so a malformed money string 422s cleanly
 * instead of crashing deep inside postJournalEntryTx. */
function assertValidMoney(value: string): void {
  try {
    parseMoney(value);
  } catch (e) {
    if (e instanceof InvalidMoneyError) {
      throw new OfflinePaymentValidationError(e.message);
    }
    throw e;
  }
}

function actorIdOf(actor: Actor): string {
  return 'employeeId' in actor ? actor.employeeId : actor.memberId;
}

interface RecordedPaymentRow {
  receipt_id: string;
  receipt_number: string;
  amount: string;
  issued_at: string;
  charge_id: string;
}

/**
 * The already-recorded payment for `(chargeId, idempotencyKey)`, if any --
 * the replay check (AC3). Joins through `entry_id` to the receipt that
 * posting issued, so the replay returns the *identical* result without
 * needing to duplicate any receipt field onto `offline_payments`.
 */
async function findExistingPayment(
  db: Database | Transaction,
  chargeId: string,
  idempotencyKey: string,
): Promise<OfflinePaymentResult | null> {
  const row = await db.queryOne<RecordedPaymentRow>(
    sql`SELECT r.id AS receipt_id, r.receipt_number, r.amount::text AS amount, r.issued_at::text AS issued_at, op.charge_id
        FROM offline_payments op
        JOIN receipts r ON r.entry_id = op.entry_id
        WHERE op.charge_id = ${chargeId} AND op.idempotency_key = ${idempotencyKey}`,
  );
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    receiptNumber: row.receipt_number,
    amount: row.amount,
    issuedAt: row.issued_at,
    chargeIds: [row.charge_id],
  };
}

/**
 * `POST /v1/charges/{chargeId}/offline-payment` business logic.
 *
 * The replay check runs first, before the transaction (the same pattern
 * STR-092's initiatePayment and STR-094's settleWebhookEvent use): by the
 * time a genuine replay arrives the charge is already `paid`, so the
 * status guard below would otherwise reject the caller's own earlier,
 * successful request as a conflict (AC3).
 *
 * Everything else happens inside one `db.transaction()`, with the charge
 * locked `FOR UPDATE` first so a concurrent second recorder blocks and then
 * sees `paid`. Both rejections -- a charge that is no longer payable, and
 * an amount that doesn't match the charge -- are checked against the locked
 * row *before* the first write, so a rejected call leaves no posting, no
 * receipt, and no status change (AC3).
 *
 * The amount must equal the charge exactly: v1 has no partial payments
 * (E10's exit criteria), and a free-form client-supplied amount would
 * otherwise let a finance-recorder misstate the immutable ledger -- the
 * same review finding STR-086's recordInvoicePayment already guards.
 */
export async function recordOfflinePayment(
  db: Database,
  bucket: FileBucket,
  chargeId: string,
  actor: Actor,
  input: RecordOfflinePaymentInput,
  idempotencyKey: string,
): Promise<OfflinePaymentResult> {
  if (input.method !== 'cash' && input.method !== 'cheque') {
    throw new OfflinePaymentValidationError('method must be "cash" or "cheque".');
  }
  if (typeof input.amount !== 'string' || input.amount === '') {
    throw new OfflinePaymentValidationError('amount is required.');
  }
  assertValidMoney(input.amount);
  const amount = formatMoney(parseMoney(input.amount));
  if (typeof input.receivedOn !== 'string' || input.receivedOn === '') {
    throw new OfflinePaymentValidationError('received_on is required.');
  }

  const existing = await findExistingPayment(db, chargeId, idempotencyKey);
  if (existing) return existing;

  return db.transaction(async tx => {
    const charge = await tx.queryOne<{ member_id: string; status: string; amount: string }>(
      sql`SELECT member_id, status, amount::text AS amount FROM charges WHERE id = ${chargeId} FOR UPDATE`,
    );
    if (!charge) {
      throw new OfflinePaymentConflictError(`Charge ${chargeId} does not exist.`);
    }
    if (charge.status !== 'due' && charge.status !== 'in_payment') {
      throw new OfflinePaymentConflictError(`Charge ${chargeId} is ${charge.status}; only a due charge can be settled offline.`);
    }
    const chargeAmount = formatMoney(parseMoney(charge.amount));
    if (!moneyEquals(amount, chargeAmount)) {
      throw new OfflinePaymentValidationError(`Payment amount ${amount} does not match the charge's amount ${chargeAmount}.`);
    }

    const description = `Offline ${input.method} payment - ${chargeId}${input.reference ? ` - ${input.reference}` : ''}`;
    const { entryId } = await postJournalEntryTx(
      tx,
      description,
      [
        { accountId: DEBITED_ACCOUNT[input.method], direction: 'debit', amount },
        { accountId: 'member_dues', direction: 'credit', amount, counterpartyType: 'member', counterpartyId: charge.member_id },
      ],
      { postedAt: input.receivedOn },
    );

    await tx.execute(sql`UPDATE charges SET status = 'paid', updated_at = now() WHERE id = ${chargeId}`);

    // Dated to when the money was collected, so the receipt's gapless per-FY
    // series (STR-071/073) and the posting itself land in the same financial
    // year.
    const receipt = await issueReceiptTx(tx, bucket, entryId, amount, { issuedOnDate: input.receivedOn });

    await tx.execute(
      sql`INSERT INTO offline_payments (id, charge_id, idempotency_key, method, amount, received_on, reference, entry_id, recorded_by)
          VALUES (${randomUUID()}, ${chargeId}, ${idempotencyKey}, ${input.method}, ${amount}::numeric, ${input.receivedOn}::date, ${input.reference ?? null}, ${entryId}, ${actorIdOf(actor)})`,
    );

    return {
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
      issuedAt: receipt.issuedAt,
      chargeIds: [chargeId],
    };
  });
}
