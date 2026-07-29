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

// STR-124 T-C1 (BE-C, covers TC-TKT-021/TC-TKT-022) — the attachment
// endpoints against their OpenAPI shapes: mobile POST/GET
// /me/tickets/{ticketId}/attachments... and admin
// GET /v1/tickets/{ticketId}/attachments/{attachmentId}.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-124 Member ${randomUUID()}` }, await asAnyStaff(db));
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`, {}, await asAnyStaff(db));
  return memberId;
}

async function adminEmployee(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/employees', { name: `STR-124 Admin ${randomUUID()}` }, await asAnyStaff(db));
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

async function attach(memberId: string, ticketId: string): Promise<string> {
  const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/attachments`, {
    file_name: 'leak.jpg',
    mime_type: 'image/jpeg',
  }, { ...(await asMember(db, memberId)) });
  expect(response.status).toBe(201);
  return (response.body as { attachment_id: string }).attachment_id;
}

describe('STR-124 T-C1 — attachment contracts on both surfaces', () => {
  it('POST /me/tickets/{id}/attachments returns attachment_id/upload_url/expires_at', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/attachments`, {
      file_name: 'leak.jpg',
      mime_type: 'image/jpeg',
    }, { ...(await asMember(db, memberId)) });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/attachments', 'post');
    expect(response.status).toBe(201);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets/{id}/attachments on a withdrawn ticket is 409 per the Error schema', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);
    await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/withdraw`, undefined, {
      ...(await asMember(db, memberId)),
    });

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/attachments`, {
      file_name: 'late.jpg',
      mime_type: 'image/jpeg',
    }, { ...(await asMember(db, memberId)) });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/attachments', 'post');
    expect(response.status).toBe(409);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    const rows = await db.query(sql`SELECT id FROM ticket_attachments WHERE ticket_id = ${ticketId}`);
    expect(rows).toEqual([]);
  });

  it('GET /me/tickets/{id}/attachments/{attachmentId} returns url/expires_at for the owner', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);
    const attachmentId = await attach(memberId, ticketId);

    const response = await dispatchRequest(
      'GET', `/v1/me/tickets/${ticketId}/attachments/${attachmentId}`, undefined,
      { ...(await asMember(db, memberId)) },
    );

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/attachments/{attachmentId}', 'get');
    expect(response.status).toBe(200);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('GET /me/tickets/{id}/attachments/{attachmentId} by another member is 404 — no presigned URL leaks', async () => {
    const owner = await createActiveMember();
    const intruder = await createActiveMember();
    const ticketId = await openTicket(owner);
    const attachmentId = await attach(owner, ticketId);

    const response = await dispatchRequest(
      'GET', `/v1/me/tickets/${ticketId}/attachments/${attachmentId}`, undefined,
      { ...(await asMember(db, intruder)) },
    );

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/attachments/{attachmentId}', 'get');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    expect(JSON.stringify(response.body)).not.toContain('http');
  });

  it('GET /v1/tickets/{id}/attachments/{attachmentId} lets staff download per the admin schema', async () => {
    const memberId = await createActiveMember();
    const staffId = await adminEmployee();
    const ticketId = await openTicket(memberId);
    const attachmentId = await attach(memberId, ticketId);

    const response = await dispatchRequest(
      'GET', `/v1/tickets/${ticketId}/attachments/${attachmentId}`, undefined,
      { ...(await asEmployee(db, staffId)) },
    );

    const op = await contractTest('admin', '/tickets/{ticketId}/attachments/{attachmentId}', 'get');
    expect(response.status).toBe(200);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /me/tickets/{id}/attachments without the member header is 401', async () => {
    const memberId = await createActiveMember();
    const ticketId = await openTicket(memberId);

    const response = await dispatchRequest('POST', `/v1/me/tickets/${ticketId}/attachments`, {
      file_name: 'x.jpg',
      mime_type: 'image/jpeg',
    });

    const op = await contractTest('mobile', '/me/tickets/{ticketId}/attachments', 'post');
    expect(response.status).toBe(401);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});
