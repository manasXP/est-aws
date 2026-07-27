// STR-086: E09's capstone story -- records payment against an approved
// invoice into the Bank or Cash book the finance-recorder chooses, posting a
// balanced entry to the Expense Ledger (STR-021's postJournalEntry,
// counterpartyType 'vendor') and linking the invoice's scanned document to
// that entry (STR-025's linkDocumentToEntry, archive-blocked the instant
// payment posts).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket } from '@aws-blocks/blocks';
import { InvoiceConflictError, InvoiceValidationError, getInvoice, type Invoice } from './invoices';
import { postJournalEntry } from '../finance/journal';
import { linkDocumentToEntry } from '../finance/documents';
import { formatMoney, parseMoney, InvalidMoneyError } from '../money';
import type { Actor } from '../members/capabilities';

export type InvoicePaymentMethod = 'bank' | 'cash';

export interface RecordInvoicePaymentInput {
  method: InvoicePaymentMethod;
  amount: string;
  paidOn: string;
  reference?: string | null;
}

/** Same money-format-check idiom as employees-api.ts's own assertValidMoney
 * -- translates parseMoney's InvalidMoneyError into an InvoiceValidationError
 * so a malformed money string 422s cleanly instead of crashing deep inside
 * postJournalEntry. */
function assertValidMoney(value: string): void {
  try {
    parseMoney(value);
  } catch (e) {
    if (e instanceof InvalidMoneyError) {
      throw new InvoiceValidationError(e.message);
    }
    throw e;
  }
}

function actorIdOf(actor: Actor): string {
  return 'employeeId' in actor ? actor.employeeId : actor.memberId;
}

function actorTypeOf(actor: Actor): 'employee' | 'member' {
  return 'employeeId' in actor ? 'employee' : 'member';
}

/**
 * `POST /invoices/{invoiceId}/payment` business logic (AC1: only an
 * `approved` invoice is payable; AC2: the scanned document links to the
 * posted entry; AC3: the acting user is recorded on the `paid` event).
 *
 * Structured as three steps, not one transaction: the row-lock + guarded
 * `approved -> paid` flip runs first and alone, because that's what closes
 * the concurrency race for a second call on the same invoice -- a losing
 * concurrent caller's locked re-read sees `paid` and 409s immediately,
 * before ever reaching postJournalEntry below. postJournalEntry itself
 * can't run inside that same transaction (it takes a `Database`, opening
 * its own commit boundary, not a `Transaction`) -- STR-021's own module
 * boundary. The final step (document link + invoice_payments row + `paid`
 * event) runs in its own transaction once the entry exists, mirroring
 * finance/receipts.ts's issueReceipt: atomicity is guaranteed through the
 * status flip; nothing after it is expected to fail in practice (the
 * ledger accounts are the fixed, always-seeded 'expense'/'bank'/'cash').
 */
export async function recordInvoicePayment(
  db: Database,
  bucket: FileBucket,
  invoiceId: string,
  actor: Actor,
  input: RecordInvoicePaymentInput,
): Promise<Invoice> {
  if (input.method !== 'bank' && input.method !== 'cash') {
    throw new InvoiceValidationError('method must be "bank" or "cash".');
  }
  if (typeof input.amount !== 'string' || input.amount === '') {
    throw new InvoiceValidationError('amount is required.');
  }
  assertValidMoney(input.amount);
  const amount = formatMoney(parseMoney(input.amount));
  if (typeof input.paidOn !== 'string' || input.paidOn === '') {
    throw new InvoiceValidationError('paid_on is required.');
  }

  let documentId = '';
  let vendorId = '';

  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ status: string; vendor_id: string; document_id: string }>(
      sql`SELECT status, vendor_id, document_id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`,
    );
    if (!locked) {
      throw new InvoiceConflictError(`Invoice ${invoiceId} does not exist.`);
    }
    if (locked.status !== 'approved') {
      throw new InvoiceConflictError(`Invoice ${invoiceId} is ${locked.status}; only an approved invoice can be paid.`);
    }
    documentId = locked.document_id;
    vendorId = locked.vendor_id;
    await tx.execute(sql`UPDATE invoices SET status = 'paid' WHERE id = ${invoiceId} AND status = 'approved'`);
  });

  const description = `Invoice payment - ${invoiceId}${input.reference ? ` - ${input.reference}` : ''}`;
  const { entryId } = await postJournalEntry(
    db,
    description,
    [
      { accountId: 'expense', direction: 'debit', amount, counterpartyType: 'vendor', counterpartyId: vendorId },
      { accountId: input.method, direction: 'credit', amount },
    ],
    { postedAt: input.paidOn },
  );

  const actorId = actorIdOf(actor);

  await db.transaction(async tx => {
    await linkDocumentToEntry(tx, bucket, entryId, documentId);
    await tx.execute(
      sql`INSERT INTO invoice_payments (id, invoice_id, method, amount, paid_on, reference, entry_id, recorded_by)
          VALUES (${randomUUID()}, ${invoiceId}, ${input.method}, ${amount}::numeric, ${input.paidOn}::date, ${input.reference ?? null}, ${entryId}, ${actorId})`,
    );
    await tx.execute(
      sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_type, notes)
          VALUES (${randomUUID()}, ${invoiceId}, 'paid', ${actorId}, ${actorTypeOf(actor)}, ${null})`,
    );
  });

  return (await getInvoice(db, invoiceId))!;
}
