import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice } from '../../aws-blocks/vendors/invoices';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { designateApprover } from '../../aws-blocks/members/capabilities';

// STR-086 T-U4/T-C1 -- HTTP-level Idempotency-Key gate and OpenAPI contract
// cases for `POST /v1/invoices/{invoiceId}/payment`. Uses the real
// `db`/`documents` singletons the registered RawRoutes read from
// (aws-blocks/index.ts), the same approach as
// test/contract/invoice-approvals.contract.test.ts. Kept separate from
// test/vendors/invoice-payments.test.ts's fresh-Database service-layer
// cases (T-U1/T-U2/T-U3/T-U5), matching that split for STR-083/STR-084.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/** An approved invoice against a fresh vendor/work order, reached entirely
 * through the existing HTTP routes (verify/approve), created directly
 * against the shared db/documents singletons. */
async function approvedInvoiceId(): Promise<string> {
  const vendor = await createVendor(db, { name: `Contract Vendor ${randomUUID()}` });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Fix leaking pipe',
    value: '5000.00',
    issuedOn: '2026-07-01',
  });
  const documentId = `invoices/${randomUUID()}.pdf`;
  await documents.put(documentId, 'invoice scan');
  const { invoice } = await submitInvoice(db, documents, workOrder.id, {
    amount: '2000.00',
    invoiceDate: '2026-07-05',
    documentId,
  });

  const verifier = await createEmployee(db, { name: 'Payment Contract Verifier' });
  await setEmployeeCapabilities(db, verifier.employee_id, ['designated-verifier']);
  await dispatchRequest('POST', `/v1/invoices/${invoice.id}/verify`, {}, { 'X-Actor-Employee-Id': verifier.employee_id });

  const approver = await createMember(db, { name: 'Payment Contract Approver' });
  await admitMember(db, approver.member_id);
  await assignRole(db, approver.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, approver.member_id, 'executive_member', '2026-01-01', 'ec-admin');
  await designateApprover(db, approver.member_id);
  await dispatchRequest('POST', `/v1/invoices/${invoice.id}/approve`, {}, { 'X-Actor-Member-Id': approver.member_id });

  return invoice.id;
}

async function financeRecorderEmployeeId(): Promise<string> {
  const employee = await createEmployee(db, { name: 'Contract Finance Recorder' });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

describe('STR-086 T-U4 -- Idempotency-Key presence gate on the payment endpoint', () => {
  it('rejects a payment with the capability present but no Idempotency-Key: 422', async () => {
    const invoiceId = await approvedInvoiceId();
    const employeeId = await financeRecorderEmployeeId();

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/payment`,
      { method: 'bank', amount: '2000.00', paid_on: '2026-07-20' },
      { 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(422);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });
});

describe('STR-086 T-C1 -- POST /v1/invoices/{invoiceId}/payment conforms to the Admin OpenAPI', () => {
  it('records payment for a finance-recorder-capable actor with an Idempotency-Key: 201 Invoice (paid)', async () => {
    const invoiceId = await approvedInvoiceId();
    const employeeId = await financeRecorderEmployeeId();

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/payment`,
      { method: 'bank', amount: '2000.00', paid_on: '2026-07-20' },
      { 'Idempotency-Key': randomUUID(), 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(201);
    const body = response.body as { status: string };
    expect(body.status).toBe('paid');

    const op = await contractTest('admin', '/invoices/{invoiceId}/payment', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('rejects payment on a non-approved invoice: 409', async () => {
    const vendor = await createVendor(db, { name: `Contract Vendor ${randomUUID()}` });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    const documentId = `invoices/${randomUUID()}.pdf`;
    await documents.put(documentId, 'invoice scan');
    const { invoice } = await submitInvoice(db, documents, workOrder.id, {
      amount: '2000.00',
      invoiceDate: '2026-07-05',
      documentId,
    });
    const employeeId = await financeRecorderEmployeeId();

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoice.id}/payment`,
      { method: 'bank', amount: '2000.00', paid_on: '2026-07-20' },
      { 'Idempotency-Key': randomUUID(), 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(409);
    const op = await contractTest('admin', '/invoices/{invoiceId}/payment', 'post');
    expect(() => op.expectValidResponse(409, response.body)).not.toThrow();
  });
});
