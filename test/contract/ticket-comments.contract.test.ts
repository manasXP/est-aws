import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asEmployee, asMember } from '../support/cognito-token';

// STR-123 T-C1 (BE-C, covers TC-TKT-008/TC-TKT-020) — the two comment
// endpoints against the shared TicketComment schema: mobile
// POST /me/tickets/{ticketId}/comments and admin
// POST /v1/tickets/{ticketId}/comments, including the 409 read-only-thread
// case on both. Real-handler dispatchRequest template throughout, matching
// tickets.contract.test.ts.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-123 Member ${randomUUID()}` }, await asAnyStaff(db));
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`, {}, await asAnyStaff(db));
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `STR-123 Admin ${randomUUID()}` }, await asAnyStaff(db));
  const employeeId = (response.body as { employee_id: string }).employee_id;
  await setEmployeeCapabilities(db, employeeId, ['finance-recorder']);
  return employeeId;
}

async function openTicket(memberId: string): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/me/tickets', {
    category: 'general',
    subject: 'Query',
    description: 'Details.',
  }, { ...(await asMember(db, memberId)) });
  expect(response.status).toBe(201);
  return (response.body as { ticket_id: string }).ticket_id;
}

describe('STR-123 T-C1 — ticket comment contracts on both surfaces', () => {
  it('POST /me/tickets/{id}/comments appends per the TicketComment schema', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/comments`, {
      body: 'Any update?',
    }, { ...(await asMember(db, memberId)) });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/comments', 'post');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ author_kind: 'member', body: 'Any update?' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/tickets/{id}/comments appends a staff reply per the TicketComment schema', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest('POST', `/v1/tickets/${ticketId}/comments`, {
      body: 'Technician booked.',
    }, { ...(await asEmployee(db, staffId)) });

    const op = await contractTest('admin', '/tickets/{ticketId}/comments', 'post');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ author_kind: 'staff', body: 'Technician booked.' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets/{id}/comments on a withdrawn ticket is 409 per the Error schema', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);
    const withdrawn = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/withdraw`, undefined, {
      ...(await asMember(db, memberId)),
    });
    expect(withdrawn.status).toBe(200);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/comments`, {
      body: 'Hello?',
    }, { ...(await asMember(db, memberId)) });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/comments', 'post');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    const rows = await db.query(sql`SELECT id FROM ticket_comments WHERE ticket_id = ${ticketId}`);
    expect(rows).toEqual([]);
  });

  it('POST /v1/tickets/{id}/comments on a withdrawn ticket is 409 per the Error schema', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);
    await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/withdraw`, undefined, {
      ...(await asMember(db, memberId)),
    });

    const response = await dispatchRequest('POST', `/v1/tickets/${ticketId}/comments`, {
      body: 'Hello?',
    }, { ...(await asEmployee(db, staffId)) });

    const op = await contractTest('admin', '/tickets/{ticketId}/comments', 'post');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets/{id}/comments without the member header is 401 per the Unauthorized schema', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/comments`, { body: 'Hi' });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/comments', 'post');
    expect(response.status).toBe(401);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets/{id}/comments on another member\'s ticket does not append', async () => {
    const owner = await createActiveMember();
    const intruder = await createActiveMember();
    const ticketId = await openTicket(owner);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/comments`, {
      body: 'Nosy.',
    }, { ...(await asMember(db, intruder)) });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/comments', 'post');
    expect([403, 404, 409]).toContain(response.status);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    const rows = await db.query(sql`SELECT id FROM ticket_comments WHERE ticket_id = ${ticketId}`);
    expect(rows).toEqual([]);
  });
});
