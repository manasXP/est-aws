import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-121 T-C1 (BE-C, covers TC-TKT-001) — mobile POST /me/tickets against
// the Ticket schema, plus the admin GET/PUT /ticket-routing pair. Real-
// handler dispatchRequest template throughout; fixtures created fresh per
// test so nothing depends on .bb-data history.
//
// Known contract wrinkle (surfaced in this story's PR): TicketRouting
// requires all four keys as plain strings, but an unconfigured or
// partially-configured deployment has nothing valid to return from GET —
// so the GET conformance case runs against a fully-configured routing.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-121 Member ${randomUUID()}` });
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`);
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `STR-121 Admin ${randomUUID()}` });
  const employeeId = (response.body as { employee_id: string }).employee_id;
  await setEmployeeCapabilities(db, employeeId, ['finance-recorder']);
  return employeeId;
}

async function configureFullRouting(): Promise<Record<string, string>> {
  const routing = {
    finance: await adminEmployee(),
    maintenance: await adminEmployee(),
    records: await adminEmployee(),
    general: await adminEmployee(),
  };
  const response = await dispatchRequest('PUT', '/v1/ticket-routing', routing);
  expect(response.status).toBe(200);
  return routing;
}

describe('STR-121 T-C1 — ticket creation and routing contracts (covers TC-TKT-001)', () => {
  it('POST /me/tickets opens the ticket as open, routed to the category default, per the Ticket schema', async () => {
    const memberId = await createActiveMember();
    const routing = await configureFullRouting();

    const response = await dispatchRequest('POST', '/v1/me/tickets', {
      category: 'finance',
      subject: 'Wrong charge',
      description: 'July maintenance billed twice.',
    }, { 'X-Actor-Member-Id': memberId });

    const op = await contractTest('mobile', '/me/tickets', 'post');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ category: 'finance', status: 'open' });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();

    // The member-facing Ticket schema carries no assignee — routing is
    // asserted at the row, where STR-126's triage queue will read it.
    const ticketId = (response.body as { ticket_id: string }).ticket_id;
    const row = await db.queryOne<{ assignee_id: string | null; member_id: string }>(
      sql`SELECT assignee_id, member_id FROM tickets WHERE id = ${ticketId}`,
    );
    expect(row).toEqual({ assignee_id: routing.finance, member_id: memberId });
  });

  it('POST /me/tickets with an unknown category is rejected 422 per the Error schema', async () => {
    const memberId = await createActiveMember();

    const response = await dispatchRequest('POST', '/v1/me/tickets', {
      category: 'plumbing',
      subject: 'x',
      description: 'y',
    }, { 'X-Actor-Member-Id': memberId });

    const op = await contractTest('mobile', '/me/tickets', 'post');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets without the member header is 401 per the Unauthorized schema', async () => {
    const response = await dispatchRequest('POST', '/v1/me/tickets', {
      category: 'general',
      subject: 'x',
      description: 'y',
    });

    const op = await contractTest('mobile', '/me/tickets', 'post');
    expect(response.status).toBe(401);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /v1/ticket-routing conforms to the TicketRouting schema once fully configured', async () => {
    const routing = await configureFullRouting();

    const response = await dispatchRequest('GET', '/v1/ticket-routing');

    const op = await contractTest('admin', '/ticket-routing', 'get');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(routing);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('PUT /v1/ticket-routing naming an employee with no admin account is 422 per the Error schema, config unchanged', async () => {
    const before = await configureFullRouting();
    const plainResponse = await dispatchRequest('POST', '/v1/employees', { name: `STR-121 Plain ${randomUUID()}` });
    const plainId = (plainResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest('PUT', '/v1/ticket-routing', { ...before, records: plainId });

    const op = await contractTest('admin', '/ticket-routing', 'put');
    expect(response.status).toBe(422);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    const after = await dispatchRequest('GET', '/v1/ticket-routing');
    expect(after.body).toEqual(before);
  });
});
