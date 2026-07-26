import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-042 T-C1 — Admin API employee CRUD, capability designation, and
// salary-payment contract cases. Uses the real `db` singleton the
// registered RawRoutes read from (aws-blocks/index.ts), the same approach
// as test/contract/members.contract.test.ts.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

describe('STR-042 T-C1 — admin employee CRUD API contract', () => {
  it('POST /v1/employees creates and conforms to the Admin OpenAPI', async () => {
    const name = `Contract Test Employee ${randomUUID()}`;
    const response = await dispatchRequest('POST', '/v1/employees', { name });

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/employees', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('PUT /v1/employees/{employeeId}/capabilities conforms to the Admin OpenAPI', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Capability Target' });
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, {
      capabilities: ['finance-recorder'],
    });

    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/employees/{employeeId}/capabilities', 'put');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });
});

describe('STR-044 T-C1 — salary-payment capability gate (real claims-derivation) and posting', () => {
  it('rejects a salary payment with no actor header: 403 capability_required', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'No Actor Payee' });
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID() },
    );

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('capability_required');

    // Known spec gap: the Admin OpenAPI doesn't declare a 403 response on
    // this operation (it's a story-level addition on top of the documented
    // shape, not itself in the spec) -- so expectValidResponse can't be
    // used for this status code. Asserted directly against the Error
    // schema shape above instead, same pattern as members.contract.test.ts's
    // pinned joining_date gap comment.
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(403, response.body)).toThrow(/no 403 response declared/);
  });

  it('rejects a salary payment for an actor without finance-recorder: 403', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Wrong Capability Payee' });
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['data-entry'] });

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID(), 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('capability_required');
  });

  it('records a salary payment for a finance-recorder-capable actor with an Idempotency-Key: 201 LedgerEntry', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Paid Employee' });
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['finance-recorder'] });

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID(), 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('rejects a salary payment with the capability present but no Idempotency-Key: 422', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'No Idempotency Payee' });
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['finance-recorder'] });

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(422);
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});
