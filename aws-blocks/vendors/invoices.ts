// STR-082: extends STR-081's invoices shell (migrations/026_vendors_work_orders.sql,
// aws-blocks/vendors/work-orders.ts) with the real invoice fields and
// submission workflow -- sitting between the invoices/invoice_events tables
// and any future HTTP layer (this story ships no routes). `invoiced_total`
// is deliberately derived from invoice state on every read (Definition of
// Done) rather than a persisted counter, so a rejected invoice falls out of
// the total the instant it's rejected (TC-VEN-003/004).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction, FileBucket } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { formatMoney, parseMoney } from '../money';
import { advanceWorkOrderToInProgress } from './work-orders';

export type InvoiceStatus = 'submitted' | 'verified' | 'approved' | 'rejected' | 'paid';

/** Domain rejection for a submission carrying an invalid attribute (e.g. a
 * document_id not found in the bucket, or a resubmission_of that doesn't
 * exist on the same work order). Nothing is written when this is thrown. */
export class InvoiceValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceValidationError';
  }
}

/** Domain rejection for a submission attempted against a work order that no
 * longer accepts invoices (cancelled, or unknown). Nothing is written when
 * this is thrown. */
export class InvoiceConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceConflictError';
  }
}

/** The Vendor Workflow spec's decided Invoice shape -- amount/gst_amount are
 * always decimal strings via formatMoney, never a raw DB numeric. */
export interface Invoice {
  id: string;
  workOrderId: string;
  vendorId: string;
  amount: string;
  gstAmount: string | null;
  invoiceNumber: string | null;
  invoiceDate: string;
  documentId: string;
  resubmissionOf: string | null;
  resubmittedAs: string | null;
  notes: string | null;
  status: InvoiceStatus;
}

interface InvoiceRow {
  id: string;
  work_order_id: string;
  vendor_id: string;
  amount: string;
  gst_amount: string | null;
  invoice_number: string | null;
  invoice_date: string | Date;
  document_id: string;
  resubmission_of: string | null;
  resubmitted_as: string | null;
  notes: string | null;
  status: InvoiceStatus;
}

function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    vendorId: row.vendor_id,
    amount: formatMoney(parseMoney(row.amount)),
    gstAmount: row.gst_amount === null ? null : formatMoney(parseMoney(row.gst_amount)),
    invoiceNumber: row.invoice_number,
    invoiceDate: toDateOnly(row.invoice_date),
    documentId: row.document_id,
    resubmissionOf: row.resubmission_of,
    resubmittedAs: row.resubmitted_as,
    notes: row.notes,
    status: row.status,
  };
}

/** A single invoice, or `null` if it doesn't exist. */
export async function getInvoice(db: Database, invoiceId: string): Promise<Invoice | null> {
  const row = await db.queryOne<InvoiceRow>(sql`SELECT * FROM invoices WHERE id = ${invoiceId}`);
  return row ? toInvoice(row) : null;
}

/**
 * The derived-sum query (AC2, TC-VEN-003/004): the live sum of every
 * non-rejected invoice on a work order. No persisted counter anywhere --
 * this is computed fresh on every call, so a rejected invoice falls out of
 * the total the instant it's rejected with no separate bookkeeping.
 */
export async function computeInvoicedTotal(db: Database | Transaction, workOrderId: string): Promise<string> {
  const row = await db.queryOne<{ total: string }>(
    sql`SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS total FROM invoices WHERE work_order_id = ${workOrderId} AND status != 'rejected'`,
  );
  return formatMoney(parseMoney(row!.total));
}

export interface SubmitInvoiceInput {
  amount: string;
  gstAmount?: string | null;
  invoiceNumber?: string | null;
  invoiceDate: string;
  documentId: string;
  resubmissionOf?: string | null;
  notes?: string | null;
  actorId?: string | null;
}

/**
 * `POST /work-orders/{workOrderId}/invoices` business logic (AC1: every
 * submitted invoice is recorded with its own audit event, and the work
 * order's first invoice flips it to `in_progress`; AC3: over-invoicing warns
 * but never blocks; AC4: refused against a cancelled work order). The
 * work-order lookup, document-existence check, resubmission_of check, the
 * insert and its `submitted` event, and the `issued -> in_progress`
 * transition all share one transaction, so a failure anywhere leaves
 * nothing written.
 */
export async function submitInvoice(
  db: Database,
  bucket: FileBucket,
  workOrderId: string,
  input: SubmitInvoiceInput,
): Promise<{ invoice: Invoice; overInvoiced: boolean }> {
  const id = randomUUID();
  const amount = formatMoney(parseMoney(input.amount));
  const gstAmount = input.gstAmount == null ? null : formatMoney(parseMoney(input.gstAmount));

  let overInvoiced = false;
  await db.transaction(async tx => {
    // FOR UPDATE (not a plain SELECT): a concurrent cancelWorkOrder's UPDATE
    // only takes a lock on the row it's writing, which a bare SELECT here
    // wouldn't wait on -- amendWorkOrder hit and fixed the identical class
    // of race (see its own comment for the full FOR KEY SHARE/FOR NO KEY
    // UPDATE explanation). Locking here means a racing cancelWorkOrder
    // either fully commits before this read (so `status` is already
    // 'cancelled') or blocks until this transaction commits/rolls back.
    const workOrder = await tx.queryOne<{ status: string; value: string; vendor_id: string }>(
      sql`SELECT status, value, vendor_id FROM work_orders WHERE id = ${workOrderId} FOR UPDATE`,
    );
    if (!workOrder) {
      throw new InvoiceConflictError(`Work order ${workOrderId} does not exist.`);
    }
    if (workOrder.status === 'cancelled') {
      throw new InvoiceConflictError(`Work order ${workOrderId} is cancelled and cannot accept new invoices.`);
    }

    const file = await bucket.get(input.documentId);
    if (!file) {
      throw new InvoiceValidationError(`No document found at: ${input.documentId}`);
    }

    if (input.resubmissionOf != null) {
      const predecessor = await tx.queryOne(
        sql`SELECT id FROM invoices WHERE id = ${input.resubmissionOf} AND work_order_id = ${workOrderId}`,
      );
      if (!predecessor) {
        throw new InvoiceValidationError(`No invoice ${input.resubmissionOf} on work order ${workOrderId}.`);
      }
    }

    await tx.execute(
      sql`INSERT INTO invoices (id, work_order_id, vendor_id, amount, gst_amount, invoice_number, invoice_date, document_id, resubmission_of, notes, status)
          VALUES (${id}, ${workOrderId}, ${workOrder.vendor_id}, ${amount}::numeric, ${gstAmount}::numeric, ${input.invoiceNumber ?? null}, ${input.invoiceDate}::date, ${input.documentId}, ${input.resubmissionOf ?? null}, ${input.notes ?? null}, 'submitted')`,
    );
    await tx.execute(
      sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, notes)
          VALUES (${randomUUID()}, ${id}, 'submitted', ${input.actorId ?? null}, ${null})`,
    );

    await advanceWorkOrderToInProgress(tx, workOrderId);

    const invoicedTotal = await computeInvoicedTotal(tx, workOrderId);
    const workOrderValue = formatMoney(parseMoney(workOrder.value));
    overInvoiced = parseMoney(invoicedTotal) > parseMoney(workOrderValue);
  });

  const invoice = await getInvoice(db, id);
  return { invoice: invoice!, overInvoiced };
}
