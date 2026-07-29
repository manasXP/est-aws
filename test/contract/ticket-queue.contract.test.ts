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

// STR-126 T-C1/T-C2 (BE-C, covers TC-TKT-026) — the admin triage queue and
// the mobile own-tickets surface against their respective OpenAPI
// documents. The shared `db` here already holds tickets from every other
// contract test file, so every case filters by its own freshly-created
// member rather than asserting on the whole table.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-126 Member ${randomUUID()}` }, await asAnyStaff(db));
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`, {}, await asAnyStaff(db));
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `STR-126 Admin ${randomUUID()}` }, await asAnyStaff(db));
  const employeeId = (response.body as { employee_id: string }).employee_id;
  await setEmployeeCapabilities(db, employeeId, ['finance-recorder']);
  return employeeId;
}

async function raise(memberId: string, category: string, subject: string): Promise<string> {
  const response = await dispatchRequest(
    'POST',
    '/v1/me/tickets',
    { category, subject, description: 'details' },
    await asMember(db, memberId),
  );
  expect(response.status).toBe(201);
  return (response.body as { ticket_id: string }).ticket_id;
}

function items(body: unknown): Array<Record<string, unknown>> {
  return (body as { items: Array<Record<string, unknown>> }).items;
}

describe('STR-126 T-C1 — the admin triage queue contract', () => {
  it('GET /v1/tickets returns a Page of Tickets, oldest first, defaulting to open', async () => {
    const memberId = await createActiveMember();
    const older = await raise(memberId, 'finance', 'Older');
    const newer = await raise(memberId, 'finance', 'Newer');
    await db.execute(sql`UPDATE tickets SET created_at = now() - '5 days'::interval WHERE id = ${older}`);

    const response = await dispatchRequest('GET', `/v1/tickets?member_id=${memberId}`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets', 'get');
    expect(response.status).toBe(200);
    expect(items(response.body).map(t => t.ticket_id)).toEqual([older, newer]);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /v1/tickets honors category, status, assignee_id and member_id independently and combined', async () => {
    const memberId = await createActiveMember();
    const other = await createActiveMember();
    const staffId = await adminEmployee();
    const finance = await raise(memberId, 'finance', 'Finance one');
    const maintenance = await raise(memberId, 'maintenance', 'Maintenance one');
    await raise(other, 'finance', 'Someone else');
    await dispatchRequest(
      'POST',
      `/v1/tickets/${maintenance}/assign`,
      { assignee_id: staffId },
      await asEmployee(db, staffId),
    );

    const op = await contractTest('admin', '/tickets', 'get');

    const byCategory = await dispatchRequest('GET', `/v1/tickets?member_id=${memberId}&category=finance`, {}, await asAnyStaff(db));
    expect(items(byCategory.body).map(t => t.ticket_id)).toEqual([finance]);
    expect(() => op.expectValidResponse(byCategory.status, byCategory.body)).not.toThrow();

    const byStatus = await dispatchRequest('GET', `/v1/tickets?member_id=${memberId}&status=in_progress`, {}, await asAnyStaff(db));
    expect(items(byStatus.body).map(t => t.ticket_id)).toEqual([maintenance]);

    const byAssignee = await dispatchRequest('GET', `/v1/tickets?assignee_id=${staffId}&status=all`, {}, await asAnyStaff(db));
    expect(items(byAssignee.body).map(t => t.ticket_id)).toEqual([maintenance]);

    const combined = await dispatchRequest(
      'GET',
      `/v1/tickets?member_id=${memberId}&category=maintenance&status=in_progress`,
      {},
      await asAnyStaff(db),
    );
    expect(items(combined.body).map(t => t.ticket_id)).toEqual([maintenance]);

    const noMatch = await dispatchRequest('GET', `/v1/tickets?member_id=${memberId}&category=records&status=all`, {}, await asAnyStaff(db));
    expect(items(noMatch.body)).toEqual([]);
    expect(() => op.expectValidResponse(noMatch.status, noMatch.body)).not.toThrow();
  });

  it('GET /v1/tickets/{ticketId} conforms to TicketDetail, and 404s an unknown id', async () => {
    const memberId = await createActiveMember();
    const ticketId = await raise(memberId, 'general', 'Gate light');
    await dispatchRequest(
      'POST',
      `/v1/tickets/${ticketId}/comments`,
      { body: 'Looking into it.' },
      await asEmployee(db, await adminEmployee()),
    );

    const response = await dispatchRequest('GET', `/v1/tickets/${ticketId}`, {}, await asAnyStaff(db));

    const op = await contractTest('admin', '/tickets/{ticketId}', 'get');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ticket_id: ticketId, status: 'open' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();

    const missing = await dispatchRequest('GET', '/v1/tickets/no-such-ticket', {}, await asAnyStaff(db));
    expect(missing.status).toBe(404);
    expect(() => op.expectValidResponse(missing.status, missing.body)).not.toThrow();
  });
});

describe('STR-126 T-C2 — the mobile own-tickets surface (covers TC-TKT-026)', () => {
  it('GET /me/tickets returns only the caller’s tickets, never another member’s', async () => {
    const mine = await createActiveMember();
    const theirs = await createActiveMember();
    const a = await raise(mine, 'finance', 'Mine A');
    const b = await raise(mine, 'maintenance', 'Mine B');
    const hidden = await raise(theirs, 'finance', 'Theirs');

    const response = await dispatchRequest('GET', '/v1/me/tickets', {}, await asMember(db, mine));

    const op = await contractTest('mobile', '/me/tickets', 'get');
    expect(response.status).toBe(200);
    const ids = items(response.body).map(t => t.ticket_id);
    expect(new Set(ids)).toEqual(new Set([a, b]));
    expect(ids).not.toContain(hidden);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /me/tickets honors ?status= and defaults to all statuses', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const open = await raise(memberId, 'finance', 'Still open');
    const picked = await raise(memberId, 'general', 'Picked up');
    await dispatchRequest(
      'POST',
      `/v1/tickets/${picked}/assign`,
      { assignee_id: staffId },
      await asEmployee(db, staffId),
    );

    const filtered = await dispatchRequest(
      'GET',
      '/v1/me/tickets?status=in_progress',
      {},
      await asMember(db, memberId),
    );
    expect(items(filtered.body).map(t => t.ticket_id)).toEqual([picked]);

    const all = await dispatchRequest('GET', '/v1/me/tickets', {}, await asMember(db, memberId));
    expect(new Set(items(all.body).map(t => t.ticket_id))).toEqual(new Set([open, picked]));

    const op = await contractTest('mobile', '/me/tickets', 'get');
    expect(() => op.expectValidResponse(filtered.status, filtered.body)).not.toThrow();
  });

  it('GET /me/tickets without the member header is 401 per the Unauthorized schema', async () => {
    const response = await dispatchRequest('GET', '/v1/me/tickets');

    const op = await contractTest('mobile', '/me/tickets', 'get');
    expect(response.status).toBe(401);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /me/tickets/{ticketId} conforms to TicketDetail for the owner and 404s another member', async () => {
    const owner = await createActiveMember();
    const stranger = await createActiveMember();
    const ticketId = await raise(owner, 'records', 'Certificate copy');
    await dispatchRequest(
      'POST',
      `/v1/me/tickets/${ticketId}/comments`,
      { body: 'Any update?' },
      await asMember(db, owner),
    );

    const op = await contractTest('mobile', '/me/tickets/{ticketId}', 'get');

    const mine = await dispatchRequest('GET', `/v1/me/tickets/${ticketId}`, {}, await asMember(db, owner));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ ticket_id: ticketId });
    expect(() => op.expectValidResponse(mine.status, mine.body)).not.toThrow();

    const notMine = await dispatchRequest('GET', `/v1/me/tickets/${ticketId}`, {}, await asMember(db, stranger));
    expect(notMine.status).toBe(404);
    expect(() => op.expectValidResponse(notMine.status, notMine.body)).not.toThrow();
  });
});
