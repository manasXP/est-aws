import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asEmployee } from '../support/cognito-token';

// STR-125 T-C1 (BE-C, covers TC-TKT-023 and TC-TKT-024) — the admin
// on-behalf POST /v1/tickets and PUT /v1/tickets/{ticketId}/work-order
// against the Admin OpenAPI's Ticket schema and its declared status codes,
// including the maintenance-only 409 guard.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-125 Member ${randomUUID()}` }, await asAnyStaff(db));
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`, {}, await asAnyStaff(db));
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `STR-125 Admin ${randomUUID()}` }, await asAnyStaff(db));
  const employeeId = (response.body as { employee_id: string }).employee_id;
  await setEmployeeCapabilities(db, employeeId, ['finance-recorder']);
  return employeeId;
}

async function aWorkOrder(): Promise<string> {
  const vendor = await createVendor(db, { name: `STR-125 Vendor ${randomUUID()}` });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Lift repair',
    value: '12500.00',
    issuedOn: '2026-07-01',
  });
  return workOrder.id;
}

async function raiseOnBehalf(category: string): Promise<string> {
  const memberId = await createActiveMember();
  const response = await dispatchRequest(
    'POST',
    '/v1/tickets',
    { member_id: memberId, category, subject: 'Lift stuck', description: 'B-wing lift on 3.' },
    { ...(await asEmployee(db, await adminEmployee())) },
  );
  expect(response.status).toBe(201);
  return (response.body as { ticket_id: string }).ticket_id;
}

describe('STR-125 T-C1 — on-behalf entry contract (covers TC-TKT-023)', () => {
  it('POST /v1/tickets opens the ticket per the Ticket schema, carrying entered_by', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();

    const response = await dispatchRequest(
      'POST',
      '/v1/tickets',
      { member_id: memberId, category: 'records', subject: 'Share certificate', description: 'Walked in.' },
      { ...(await asEmployee(db, staffId)) },
    );

    const op = await contractTest('admin', '/tickets', 'post');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      member_id: memberId,
      entered_by: staffId,
      status: 'open',
      work_order_id: null,
    });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/tickets naming an unknown member is 422 per the Error schema', async () => {
    const response = await dispatchRequest(
      'POST',
      '/v1/tickets',
      { member_id: 'no-such-member', category: 'general', subject: 'x', description: 'y' },
      { ...(await asEmployee(db, await adminEmployee())) },
    );

    const op = await contractTest('admin', '/tickets', 'post');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

describe('STR-125 T-C1 — work-order link contract (covers TC-TKT-024)', () => {
  it('PUT /v1/tickets/{ticketId}/work-order sets the link per the Ticket schema, status unchanged', async () => {
    const ticketId = await raiseOnBehalf('maintenance');
    const workOrderId = await aWorkOrder();

    const response = await dispatchRequest('PUT', `/v1/tickets/${ticketId}/work-order`, {
      work_order_id: workOrderId,
    }, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets/{ticketId}/work-order', 'put');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ work_order_id: workOrderId, status: 'open', resolution_note: null });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PUT with a null work_order_id clears the link, still per the Ticket schema', async () => {
    const ticketId = await raiseOnBehalf('maintenance');
    await dispatchRequest('PUT', `/v1/tickets/${ticketId}/work-order`, { work_order_id: await aWorkOrder() }, await asAnyStaff(db));

    const response = await dispatchRequest('PUT', `/v1/tickets/${ticketId}/work-order`, { work_order_id: null }, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets/{ticketId}/work-order', 'put');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ work_order_id: null, status: 'open' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PUT on a non-maintenance ticket is 409 per the Conflict schema', async () => {
    const ticketId = await raiseOnBehalf('finance');

    const response = await dispatchRequest('PUT', `/v1/tickets/${ticketId}/work-order`, {
      work_order_id: await aWorkOrder(),
    }, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets/{ticketId}/work-order', 'put');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PUT on an unknown ticket is 404 per the NotFound schema', async () => {
    const response = await dispatchRequest('PUT', '/v1/tickets/no-such-ticket/work-order', {
      work_order_id: await aWorkOrder(),
    }, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets/{ticketId}/work-order', 'put');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});
