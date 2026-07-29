import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// Contract coverage for STR-122's two ADMIN lifecycle transitions, which
// no test had ever validated against the Admin OpenAPI. Both declare a
// `Ticket` response, and the admin Ticket schema requires `member_name` --
// which the member-facing shape these handlers returned does not carry.
//
// The mobile pair (`/v1/me/tickets/{id}/reopen`, `/withdraw`) is
// deliberately untouched: those answer the *mobile* Ticket schema, which
// has no member_name and must not gain one.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `Lifecycle Member ${randomUUID()}` });
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`);
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `Lifecycle Admin ${randomUUID()}` });
  const employeeId = (response.body as { employee_id: string }).employee_id;
  await setEmployeeCapabilities(db, employeeId, ['finance-recorder']);
  return employeeId;
}

async function openTicket(memberId: string): Promise<string> {
  const response = await dispatchRequest(
    'POST',
    '/v1/me/tickets',
    { category: 'general', subject: 'Gate light', description: 'Out since Monday.' },
    { 'X-Actor-Member-Id': memberId },
  );
  expect(response.status).toBe(201);
  return (response.body as { ticket_id: string }).ticket_id;
}

describe('admin ticket transitions conform to the Admin OpenAPI Ticket schema', () => {
  it('POST /v1/tickets/{ticketId}/assign returns an admin Ticket, carrying member_name', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/assign`,
      { assignee_id: staffId },
      { 'X-Actor-Employee-Id': staffId },
    );

    const op = await contractTest('admin', '/tickets/{ticketId}/assign', 'post');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ticket_id: ticketId, member_id: memberId, status: 'in_progress' });
    expect((response.body as { member_name: string }).member_name).toBeTruthy();
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/tickets/{ticketId}/resolve returns an admin Ticket, carrying member_name', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);
    await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/assign`,
      { assignee_id: staffId },
      { 'X-Actor-Employee-Id': staffId },
    );

    const response = await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/resolve`,
      { resolution_note: 'Bulb replaced.' },
      { 'X-Actor-Employee-Id': staffId },
    );

    const op = await contractTest('admin', '/tickets/{ticketId}/resolve', 'post');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'resolved', resolution_note: 'Bulb replaced.' });
    expect((response.body as { member_name: string }).member_name).toBeTruthy();
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('the mobile reopen still answers the member-facing shape, with no member_name', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);
    await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/assign`,
      { assignee_id: staffId },
      { 'X-Actor-Employee-Id': staffId },
    );
    await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/resolve`,
      { resolution_note: 'Bulb replaced.' },
      { 'X-Actor-Employee-Id': staffId },
    );

    const response = await dispatchRequest(
      'POST',
      `/v1/me/tickets/${ticketId}/reopen`,
      {},
      { 'X-Actor-Member-Id': memberId },
    );

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/reopen', 'post');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('member_name');
    expect(response.body).not.toHaveProperty('member_id');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});
