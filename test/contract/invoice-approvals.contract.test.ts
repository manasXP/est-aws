import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice } from '../../aws-blocks/vendors/invoices';
import { rejectInvoice } from '../../aws-blocks/vendors/invoice-approvals';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { designateApprover } from '../../aws-blocks/members/capabilities';
import { asEmployee, asMember } from '../support/cognito-token';

// STR-083 T-U2/T-C1 -- HTTP-level capability-gate and OpenAPI contract cases
// for `POST /v1/invoices/{invoiceId}/verify` and `/approve`. Uses the real
// `db`/`documents` singletons the registered RawRoutes read from
// (aws-blocks/index.ts), the same approach as
// test/contract/employees.contract.test.ts. Kept separate from
// test/vendors/invoice-approvals.test.ts's fresh-Database service-layer
// cases (T-U1/T-U3/T-U4/T-U5), matching that split for STR-042/044.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/** A freshly submitted invoice against a fresh vendor/work order, created
 * directly against the shared db/documents singletons (no HTTP route exists
 * for work-order/invoice creation -- STR-081/082 shipped none). */
async function submittedInvoiceId(): Promise<string> {
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
  return invoice.id;
}

describe('STR-083 T-U2 (TC-VEN-021) -- a non-designated employee attempts verification', () => {
  // TC-VEN-021 | BE-U | Given a non-designated employee; When they attempt
  // verification; Then 403 `capability_required`
  it('rejects with 403 capability_required', async () => {
    const invoiceId = await submittedInvoiceId();
    const employee = await createEmployee(db, { name: 'Undesignated Employee' });

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/verify`,
      {},
      { ...(await asEmployee(db, employee.employee_id)) },
    );

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('capability_required');
  });
});

describe('STR-083 T-C1 -- POST /v1/invoices/{invoiceId}/verify and /approve conform to the Admin OpenAPI', () => {
  it('POST /v1/invoices/{invoiceId}/verify conforms to the Admin OpenAPI', async () => {
    const invoiceId = await submittedInvoiceId();
    const employee = await createEmployee(db, { name: 'Contract Verifier' });
    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/verify`,
      { notes: 'Checked against PO' },
      { ...(await asEmployee(db, employee.employee_id)) },
    );

    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/invoices/{invoiceId}/verify', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('POST /v1/invoices/{invoiceId}/approve conforms to the Admin OpenAPI', async () => {
    const invoiceId = await submittedInvoiceId();
    const employee = await createEmployee(db, { name: 'Contract Verifier 2' });
    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);
    await dispatchRequest('POST', `/v1/invoices/${invoiceId}/verify`, {}, { ...(await asEmployee(db, employee.employee_id)) });

    const member = await createMember(db, { name: 'Contract Approver' });
    await admitMember(db, member.member_id);
    await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'ec-admin');
    await designateApprover(db, member.member_id);

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/approve`,
      { notes: 'Approved' },
      { ...(await asMember(db, member.member_id)) },
    );

    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/invoices/{invoiceId}/approve', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });
});

describe("STR-084 (HTTP dispatch, not in the story's own Red list -- Green section explicitly requires /approve to dispatch by status) -- POST /v1/invoices/{invoiceId}/approve on a rejected invoice runs the EC override, not the designated-approver path", () => {
  it('a non-designated EC member casts a valid override vote via the existing /approve route, 200', async () => {
    const invoiceId = await submittedInvoiceId();
    const employee = await createEmployee(db, { name: 'Contract Verifier 3' });
    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);
    await dispatchRequest('POST', `/v1/invoices/${invoiceId}/verify`, {}, { ...(await asEmployee(db, employee.employee_id)) });

    // Reject directly against the service layer -- there's no /reject HTTP
    // route in this story (deferred to STR-085 per the story's own
    // Dependencies section).
    const rejecter = await createMember(db, { name: 'Contract Rejecter' });
    await admitMember(db, rejecter.member_id);
    await assignRole(db, rejecter.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, rejecter.member_id, 'executive_member', '2026-01-01', 'ec-admin');
    await designateApprover(db, rejecter.member_id);
    await rejectInvoice(db, invoiceId, rejecter.member_id, 'Amount mismatch');

    // A plain EC member, not in the designated-approver subset.
    const ecOne = await createMember(db, { name: 'Contract EC One' });
    await admitMember(db, ecOne.member_id);
    await assignRole(db, ecOne.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, ecOne.member_id, 'executive_member', '2026-01-01', 'ec-admin');

    const response = await dispatchRequest(
      'POST',
      `/v1/invoices/${invoiceId}/approve`,
      { notes: 'Override vote' },
      { ...(await asMember(db, ecOne.member_id)) },
    );

    expect(response.status).toBe(200);
    // required_count depends on the *entire* EC's live membership, which
    // this shared `db` singleton accumulates across every contract test in
    // this file (and prior runs against the same persistent .bb-data store)
    // -- so only approved_count (scoped to this one invoice) is asserted
    // exactly; required_count is asserted structurally instead.
    const body = response.body as { status: string; approval_progress: { approved_count: number; required_count: number } };
    expect(body.status).toBe('rejected');
    expect(body.approval_progress.approved_count).toBe(1);
    expect(typeof body.approval_progress.required_count).toBe('number');

    const op = await contractTest('admin', '/invoices/{invoiceId}/approve', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });
});
