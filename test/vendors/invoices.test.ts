import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createVendor, createWorkOrder, cancelWorkOrder, getWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice, computeInvoicedTotal, InvoiceConflictError } from '../../aws-blocks/vendors/invoices';
import { contractTest } from '../contract/harness';

// STR-082 -- invoice submission and invoiced-total tracking, unit cases.
// Follows the STR-081 test pattern (test/vendors/work-orders.test.ts): fresh
// Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR. Follows test/finance/documents.test.ts's freshBucket()
// pattern for the FileBucket document-existence check.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-082-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-082-test-${randomUUID()}`), 'documents');
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

describe('STR-082 T-U1 -- submitting a full invoice against a fresh work order', () => {
  it('stores it submitted, writes an invoice_events row, and flips the work order issued -> in_progress', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await bucket.put('invoices/inv-1.pdf', 'invoice scan');

    const { invoice } = await submitInvoice(db, bucket, workOrder.id, {
      amount: '5000.00',
      invoiceDate: '2026-07-10',
      documentId: 'invoices/inv-1.pdf',
    });

    expect(invoice.status).toBe('submitted');
    expect(invoice.workOrderId).toBe(workOrder.id);
    expect(invoice.vendorId).toBe(vendor.id);
    expect(invoice.amount).toBe('5000.00');

    const events = await db.query<{ action: string }>(
      sql`SELECT action FROM invoice_events WHERE invoice_id = ${invoice.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['submitted']);

    const refetchedWorkOrder = await getWorkOrder(db, workOrder.id);
    expect(refetchedWorkOrder!.status).toBe('in_progress');
  });
});

describe('STR-082 T-U2 (TC-VEN-003) — multiple invoices on one work order', () => {
  // TC-VEN-003 | BE-U | Given multiple invoices on one work order; Then
  // `invoiced_total` is the cumulative sum of non-rejected invoices, tracked
  // against work-order value
  it('invoiced_total is the cumulative sum of non-rejected invoices, tracked against work-order value', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await bucket.put('invoices/inv-1.pdf', 'invoice scan 1');
    await bucket.put('invoices/inv-2.pdf', 'invoice scan 2');

    await submitInvoice(db, bucket, workOrder.id, { amount: '2000.00', invoiceDate: '2026-07-05', documentId: 'invoices/inv-1.pdf' });
    await submitInvoice(db, bucket, workOrder.id, { amount: '1500.00', invoiceDate: '2026-07-10', documentId: 'invoices/inv-2.pdf' });

    await expect(computeInvoicedTotal(db, workOrder.id)).resolves.toBe('3500.00');
  });
});

describe('STR-082 T-U3 (TC-VEN-004) — a rejected invoice', () => {
  // TC-VEN-004 | BE-U | Given a rejected invoice; Then it is excluded from
  // `invoiced_total`
  it('is excluded from invoiced_total', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await bucket.put('invoices/inv-1.pdf', 'invoice scan');
    await submitInvoice(db, bucket, workOrder.id, { amount: '2000.00', invoiceDate: '2026-07-05', documentId: 'invoices/inv-1.pdf' });

    // Seeded directly via raw SQL, mirroring how work-orders.test.ts seeded
    // an invoice into the STR-081 shell.
    await db.execute(
      sql`INSERT INTO invoices (id, work_order_id, vendor_id, amount, invoice_date, document_id, status)
          VALUES (${randomUUID()}, ${workOrder.id}, ${vendor.id}, ${'1000.00'}::numeric, ${'2026-07-06'}::date, ${'invoices/inv-rejected.pdf'}, 'rejected')`,
    );

    await expect(computeInvoicedTotal(db, workOrder.id)).resolves.toBe('2000.00');
  });
});

describe('STR-082 T-U4 -- submitting an invoice against a cancelled work order', () => {
  it('fails with InvoiceConflictError and writes nothing', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await cancelWorkOrder(db, workOrder.id);
    await bucket.put('invoices/inv-1.pdf', 'invoice scan');

    await expect(
      submitInvoice(db, bucket, workOrder.id, { amount: '2000.00', invoiceDate: '2026-07-05', documentId: 'invoices/inv-1.pdf' }),
    ).rejects.toThrow(InvoiceConflictError);

    const invoices = await db.query(sql`SELECT id FROM invoices`);
    expect(invoices).toHaveLength(0);
    const events = await db.query(sql`SELECT id FROM invoice_events`);
    expect(events).toHaveLength(0);
  });
});

describe('STR-082 T-U5 -- a submission that pushes invoiced_total past the work-order value', () => {
  it('still succeeds, with overInvoiced: true in the response', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await bucket.put('invoices/inv-1.pdf', 'invoice scan');

    const { invoice, overInvoiced } = await submitInvoice(db, bucket, workOrder.id, {
      amount: '6000.00',
      invoiceDate: '2026-07-05',
      documentId: 'invoices/inv-1.pdf',
    });

    expect(invoice.status).toBe('submitted');
    expect(overInvoiced).toBe(true);
  });
});

describe('STR-082 T-C1 -- POST /v1/work-orders/{workOrderId}/invoices response conforms to the Admin OpenAPI', () => {
  // No HTTP route exists yet (this story ships no route, matching STR-081's
  // own scope) -- so there is nothing for dispatchRequest to hit. Instead,
  // this translates submitInvoice's real return value to the wire shape and
  // validates it against the declared 201 Invoice schema via the same
  // harness (test/contract/harness.ts) the route-backed contract tests use,
  // proving the field names/types this story's service layer produces are
  // exactly what the OpenAPI document promises once a route is wired on top.
  it("the real submitInvoice response, translated to the wire shape, validates against the declared 201 schema", async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await bucket.put('invoices/inv-1.pdf', 'invoice scan');

    const { invoice } = await submitInvoice(db, bucket, workOrder.id, {
      amount: '2500.00',
      invoiceDate: '2026-07-05',
      documentId: 'invoices/inv-1.pdf',
    });

    const body = {
      invoice_id: invoice.id,
      work_order_id: invoice.workOrderId,
      vendor_id: invoice.vendorId,
      amount: invoice.amount,
      status: invoice.status,
      invoice_date: invoice.invoiceDate,
      document_id: invoice.documentId,
      resubmission_of: invoice.resubmissionOf,
      resubmitted_as: invoice.resubmittedAs,
    };

    const op = await contractTest('admin', '/work-orders/{workOrderId}/invoices', 'post');
    expect(() => op.expectValidResponse(201, body)).not.toThrow();
  });
});
