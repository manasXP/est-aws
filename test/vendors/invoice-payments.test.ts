import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice, getInvoice, InvoiceConflictError, InvoiceValidationError, type Invoice } from '../../aws-blocks/vendors/invoices';
import { verifyInvoice, recordApproval } from '../../aws-blocks/vendors/invoice-approvals';
import { recordInvoicePayment, type RecordInvoicePaymentInput } from '../../aws-blocks/vendors/invoice-payments';
import { isDocumentLinkedToLedger } from '../../aws-blocks/finance/documents';
import { createEmployee, setEmployeeCapabilities, type Employee } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { designateApprover } from '../../aws-blocks/members/capabilities';

// STR-086 -- payment recording and full audit trail, unit cases against a
// fresh Database (no HTTP dispatch). Follows the STR-083/STR-084 test
// pattern (test/vendors/invoice-approvals.test.ts). T-U4 (Idempotency-Key,
// HTTP-level) and T-C1 (the OpenAPI contract case) live in
// test/contract/invoice-payments.contract.test.ts instead, matching that
// established split.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-086-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-086-test-${randomUUID()}`), 'documents');
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

/** An approved invoice, reached via a single verifier + a single designated
 * approver (majorityThreshold(1) === 1, flips immediately on the first
 * vote) -- mirrors test/vendors/invoice-approvals.test.ts's own setup. */
async function approvedInvoice(db: Database, bucket: FileBucket, options: { submitterId?: string } = {}): Promise<Invoice> {
  const vendor = await createVendor(db, { name: 'Acme Plumbing' });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Fix leaking pipe',
    value: '5000.00',
    issuedOn: '2026-07-01',
  });
  const documentId = `invoices/${randomUUID()}.pdf`;
  await bucket.put(documentId, 'invoice scan');
  const { invoice } = await submitInvoice(db, bucket, workOrder.id, {
    amount: '2000.00',
    invoiceDate: '2026-07-05',
    documentId,
    actorId: options.submitterId ?? null,
  });

  const verifier = await createEmployee(db, { name: 'Verifier Employee' });
  await setEmployeeCapabilities(db, verifier.employee_id, ['designated-verifier']);
  await verifyInvoice(db, invoice.id, verifier.employee_id);

  const approver = await createMember(db, { name: 'Sole Approver' });
  await admitMember(db, approver.member_id);
  await assignRole(db, approver.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, approver.member_id, 'executive_member', '2026-01-01', 'ec-admin');
  await designateApprover(db, approver.member_id);
  const { invoice: approved } = await recordApproval(db, invoice.id, approver.member_id);

  return approved;
}

async function financeRecorderEmployee(db: Database): Promise<Employee> {
  const employee = await createEmployee(db, { name: 'Finance Recorder' });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee;
}

const paymentInput: RecordInvoicePaymentInput = {
  method: 'bank',
  amount: '2000.00',
  paidOn: '2026-07-20',
};

describe('STR-086 T-U1 (TC-VEN-040) -- the finance-recorder records payment on an approved invoice', () => {
  it('moves the invoice to paid and posts a balanced debit-expense/credit-bank entry, counterpartyType vendor', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await approvedInvoice(db, bucket);
    const recorder = await financeRecorderEmployee(db);

    const paid = await recordInvoicePayment(db, bucket, invoice.id, { employeeId: recorder.employee_id }, paymentInput);

    expect(paid.status).toBe('paid');

    const lines = await db.query<{
      account_id: string;
      direction: string;
      amount: string;
      counterparty_type: string | null;
      counterparty_id: string | null;
    }>(sql`
      SELECT jl.account_id, jl.direction, jl.amount, jl.counterparty_type, jl.counterparty_id
      FROM journal_lines jl
      JOIN invoice_payments ip ON ip.entry_id = jl.entry_id
      WHERE ip.invoice_id = ${invoice.id}
      ORDER BY jl.direction
    `);
    expect(lines).toHaveLength(2);
    const credit = lines.find(l => l.direction === 'credit')!;
    const debit = lines.find(l => l.direction === 'debit')!;
    expect(debit).toMatchObject({ account_id: 'expense', amount: '2000.00', counterparty_type: 'vendor', counterparty_id: invoice.vendorId });
    expect(credit).toMatchObject({ account_id: 'bank', amount: '2000.00' });
  });
});

describe('STR-086 T-U2 (TC-VEN-041) -- a payment attempt on an invoice that is not yet approved fails', () => {
  it('rejects with InvoiceConflictError; nothing posts, nothing is written', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    const documentId = `invoices/${randomUUID()}.pdf`;
    await bucket.put(documentId, 'invoice scan');
    const { invoice } = await submitInvoice(db, bucket, workOrder.id, {
      amount: '2000.00',
      invoiceDate: '2026-07-05',
      documentId,
    });
    const recorder = await financeRecorderEmployee(db);

    await expect(recordInvoicePayment(db, bucket, invoice.id, { employeeId: recorder.employee_id }, paymentInput)).rejects.toThrow(
      InvoiceConflictError,
    );

    const stillSubmitted = await getInvoice(db, invoice.id);
    expect(stillSubmitted!.status).toBe('submitted');

    const events = await db.query<{ action: string }>(sql`SELECT action FROM invoice_events WHERE invoice_id = ${invoice.id}`);
    expect(events.map(e => e.action)).toEqual(['submitted']);

    const payments = await db.query(sql`SELECT id FROM invoice_payments WHERE invoice_id = ${invoice.id}`);
    expect(payments).toHaveLength(0);

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(0);
  });
});

describe('STR-086 T-U3 (TC-VEN-042) -- the full lifecycle records the acting user at every step', () => {
  it('invoice_events plus invoice_approvals together record submit/verify/approve/pay actors', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const submitter = await createEmployee(db, { name: 'Submitting Employee' });
    const invoice = await approvedInvoice(db, bucket, { submitterId: submitter.employee_id });
    const recorder = await financeRecorderEmployee(db);

    await recordInvoicePayment(db, bucket, invoice.id, { employeeId: recorder.employee_id }, paymentInput);

    const events = await db.query<{ action: string; actor_id: string | null }>(
      sql`SELECT action, actor_id FROM invoice_events WHERE invoice_id = ${invoice.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['submitted', 'verified', 'approved', 'paid']);
    expect(events[0].actor_id).toBe(submitter.employee_id);
    expect(events[3].actor_id).toBe(recorder.employee_id);

    const approvals = await db.query<{ member_id: string }>(sql`SELECT member_id FROM invoice_approvals WHERE invoice_id = ${invoice.id}`);
    expect(approvals).toHaveLength(1);
  });
});

describe('STR-086 T-U5 -- payment links the invoice document to the posted entry', () => {
  it('the scanned document becomes ledger-linked via isDocumentLinkedToLedger, same as any other', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await approvedInvoice(db, bucket);
    const recorder = await financeRecorderEmployee(db);

    await expect(isDocumentLinkedToLedger(db, invoice.documentId)).resolves.toBe(false);

    await recordInvoicePayment(db, bucket, invoice.id, { employeeId: recorder.employee_id }, paymentInput);

    await expect(isDocumentLinkedToLedger(db, invoice.documentId)).resolves.toBe(true);
  });
});

// Genuine gap found in code review, not in the story's own Red plan: a
// client-supplied payment amount that doesn't match what was actually
// approved would otherwise post an arbitrary, unreconciled entry to the
// immutable Expense Ledger with no server-side signal, and (before this
// fix) could strand the invoice at 'paid' with no journal entry at all if
// the mismatched amount also failed postJournalEntry's own positivity
// check -- see aws-blocks/vendors/invoice-payments.ts's recordInvoicePayment
// for the fix (checked before the approved -> paid flip, not after).
describe("STR-086 (review finding) -- a payment amount that doesn't match the invoice's approved amount is rejected", () => {
  it('rejects with InvoiceValidationError; the invoice stays approved and nothing is written', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await approvedInvoice(db, bucket);
    const recorder = await financeRecorderEmployee(db);

    await expect(
      recordInvoicePayment(db, bucket, invoice.id, { employeeId: recorder.employee_id }, { ...paymentInput, amount: '1.00' }),
    ).rejects.toThrow(InvoiceValidationError);

    const stillApproved = await getInvoice(db, invoice.id);
    expect(stillApproved!.status).toBe('approved');

    const payments = await db.query(sql`SELECT id FROM invoice_payments WHERE invoice_id = ${invoice.id}`);
    expect(payments).toHaveLength(0);

    const entries = await db.query(sql`SELECT id FROM journal_entries`);
    expect(entries).toHaveLength(0);
  });
});
