import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice, getInvoice, getInvoiceActions } from '../../aws-blocks/vendors/invoices';
import { rejectInvoice } from '../../aws-blocks/vendors/invoice-approvals';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { designateApprover } from '../../aws-blocks/members/capabilities';

// STR-085 -- the Mobile Public API's EC approval inbox (`/ec/invoices*`),
// thin adapters over STR-083/084's shared invoice-approvals.ts functions.
// Same approach as test/contract/invoice-approvals.contract.test.ts: dispatch
// the real handlers against the singleton `db`, feed responses through the
// harness.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/** A fresh vendor/work order/invoice, verified via the existing Admin HTTP
 * route (there is no HTTP route to create a work order/invoice -- STR-081/082
 * shipped none, same precedent as invoice-approvals.contract.test.ts's own
 * submittedInvoiceId). */
async function verifiedInvoiceId(): Promise<string> {
  const vendor = await createVendor(db, { name: `EC Contract Vendor ${randomUUID()}` });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Repaint common corridor',
    value: '8000.00',
    issuedOn: '2026-07-01',
  });
  const documentId = `invoices/${randomUUID()}.pdf`;
  await documents.put(documentId, 'invoice scan');
  const { invoice } = await submitInvoice(db, documents, workOrder.id, {
    amount: '3000.00',
    invoiceDate: '2026-07-05',
    documentId,
  });
  const employee = await createEmployee(db, { name: 'EC Contract Verifier' });
  await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);
  await dispatchRequest('POST', `/v1/invoices/${invoice.id}/verify`, {}, { 'X-Actor-Employee-Id': employee.employee_id });
  return invoice.id;
}

/** A member holding an open EC office plus the designated-approver capability. */
async function designatedApproverMember(name: string): Promise<string> {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'ec-admin');
  await designateApprover(db, member.member_id);
  return member.member_id;
}

/** A member holding an open EC office but NOT the designated-approver capability. */
async function ecMemberOnly(name: string): Promise<string> {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'ec-admin');
  return member.member_id;
}

describe('STR-085 T-C1 (TC-VEN-029) -- mobile /ec and the shared workflow state converge', () => {
  it('a mobile approval is visible in the shared workflow state and audit trail', async () => {
    // This story ships no Admin GET route (flagged in STR-084's Revision
    // History as a follow-up story) -- the shared service layer admin's own
    // routes are built on stands in for "the admin surface" here, the same
    // way invoice-approvals.contract.test.ts's own STR-084 case stood in for
    // a missing Admin reject route by calling rejectInvoice directly.
    const invoiceId = await verifiedInvoiceId();
    const approverId = await designatedApproverMember('EC Mobile Approver');

    const approveResponse = await dispatchRequest(
      'POST',
      `/v1/ec/invoices/${invoiceId}/approve`,
      { notes: 'Looks correct' },
      { 'X-Actor-Member-Id': approverId },
    );
    expect(approveResponse.status).toBe(200);

    const groundTruth = await getInvoice(db, invoiceId);
    const groundTruthActions = await getInvoiceActions(db, invoiceId);
    const body = approveResponse.body as {
      status: string;
      approval_progress: { approved_count: number };
      actions: { action: string; actor_id: string | null }[];
    };
    expect(body.status).toBe(groundTruth!.status);
    expect(body.approval_progress.approved_count).toBe(1);
    expect(body.actions.map(a => a.action)).toEqual(groundTruthActions.map(a => a.action));
    expect(body.actions.some(a => a.action === 'approved' && a.actor_id === approverId)).toBe(
      groundTruthActions.some(a => a.action === 'approved' && a.actorId === approverId),
    );
  });

  it('a rejection recorded through the shared service layer is visible via the mobile GET route (the reverse direction)', async () => {
    const invoiceId = await verifiedInvoiceId();
    const rejecterId = await designatedApproverMember('EC Admin-Side Rejecter');
    await rejectInvoice(db, invoiceId, rejecterId, 'Amount does not match the work order');

    const mobileGetResponse = await dispatchRequest('GET', `/v1/ec/invoices/${invoiceId}`, {}, { 'X-Actor-Member-Id': rejecterId });
    expect(mobileGetResponse.status).toBe(200);
    const body = mobileGetResponse.body as { status: string; actions: { action: string; notes?: string }[] };
    expect(body.status).toBe('rejected');
    expect(body.actions.some(a => a.action === 'rejected' && a.notes === 'Amount does not match the work order')).toBe(true);
  });
});

describe('STR-085 T-C2 -- mobile /ec routes conform to the Mobile OpenAPI', () => {
  it('GET /v1/ec/invoices conforms', async () => {
    await verifiedInvoiceId();
    const approverId = await designatedApproverMember('EC List Approver');
    const response = await dispatchRequest('GET', '/v1/ec/invoices?status=verified', {}, { 'X-Actor-Member-Id': approverId });
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/ec/invoices', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('GET /v1/ec/invoices/{invoiceId} conforms', async () => {
    const invoiceId = await verifiedInvoiceId();
    const approverId = await designatedApproverMember('EC Get Approver');
    const response = await dispatchRequest('GET', `/v1/ec/invoices/${invoiceId}`, {}, { 'X-Actor-Member-Id': approverId });
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/ec/invoices/{invoiceId}', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('GET /v1/ec/invoices/{invoiceId}/document conforms', async () => {
    const invoiceId = await verifiedInvoiceId();
    const approverId = await designatedApproverMember('EC Document Approver');
    const response = await dispatchRequest('GET', `/v1/ec/invoices/${invoiceId}/document`, {}, { 'X-Actor-Member-Id': approverId });
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/ec/invoices/{invoiceId}/document', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('POST /v1/ec/invoices/{invoiceId}/approve conforms', async () => {
    const invoiceId = await verifiedInvoiceId();
    const approverId = await designatedApproverMember('EC Approve Contract');
    const response = await dispatchRequest(
      'POST',
      `/v1/ec/invoices/${invoiceId}/approve`,
      { notes: 'ok' },
      { 'X-Actor-Member-Id': approverId },
    );
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/ec/invoices/{invoiceId}/approve', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('POST /v1/ec/invoices/{invoiceId}/reject conforms', async () => {
    const invoiceId = await verifiedInvoiceId();
    const rejecterId = await designatedApproverMember('EC Reject Contract');
    const response = await dispatchRequest(
      'POST',
      `/v1/ec/invoices/${invoiceId}/reject`,
      { reason: 'Wrong amount' },
      { 'X-Actor-Member-Id': rejecterId },
    );
    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/ec/invoices/{invoiceId}/reject', 'post');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('a caller with no capability gets the Forbidden error shape', async () => {
    const invoiceId = await verifiedInvoiceId();
    const outsider = await createMember(db, { name: 'EC Outsider' });
    await admitMember(db, outsider.member_id);

    const response = await dispatchRequest('GET', `/v1/ec/invoices/${invoiceId}`, {}, { 'X-Actor-Member-Id': outsider.member_id });
    expect(response.status).toBe(403);
    const op = await contractTest('mobile', '/ec/invoices/{invoiceId}', 'get');
    expect(() => op.expectValidResponse(403, response.body)).not.toThrow();
  });
});

describe('STR-085 T-U1 -- mobile capability gating mirrors the admin path exactly', () => {
  it('a member with neither designated-approver nor a current EC office gets 403 approving a verified invoice', async () => {
    const invoiceId = await verifiedInvoiceId();
    const outsider = await createMember(db, { name: 'EC Non-Approver' });
    await admitMember(db, outsider.member_id);

    const response = await dispatchRequest(
      'POST',
      `/v1/ec/invoices/${invoiceId}/approve`,
      { notes: 'Trying anyway' },
      { 'X-Actor-Member-Id': outsider.member_id },
    );
    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('capability_required');
  });

  it('a current EC member with no designated-approver designation successfully overrides a rejected invoice', async () => {
    const invoiceId = await verifiedInvoiceId();
    const rejecterId = await designatedApproverMember('EC Rejecter For Override');
    await rejectInvoice(db, invoiceId, rejecterId, 'Duplicate invoice');

    const ecMemberId = await ecMemberOnly('EC Plain Member Override');
    const response = await dispatchRequest(
      'POST',
      `/v1/ec/invoices/${invoiceId}/approve`,
      { notes: 'Override vote' },
      { 'X-Actor-Member-Id': ecMemberId },
    );
    expect(response.status).toBe(200);
    const body = response.body as { status: string; approval_progress: { approved_count: number } };
    expect(body.status).toBe('rejected');
    expect(body.approval_progress.approved_count).toBe(1);
  });
});
