import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asEmployee } from '../support/cognito-token';

// STR-042 T-C1 — Admin API employee CRUD, capability designation, and
// salary-payment contract cases. Uses the real `db` singleton the
// registered RawRoutes read from (aws-blocks/index.ts), the same approach
// as test/contract/members.contract.test.ts.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

/**
 * STR-045: an authenticated caller for the routes that only record *who*
 * acted rather than gating on a capability (the asset-view-grants PUT).
 * Anonymous is now 401 there, so these cases need a real linked actor even
 * though no capability is required of it.
 */
async function asSomeAuthenticatedStaff(): Promise<Record<string, string>> {
  const created = await dispatchRequest('POST', '/v1/employees', { name: `Grantor ${randomUUID()}` }, await asAnyStaff(db));
  return asEmployee(db, (created.body as { employee_id: string }).employee_id);
}

describe('STR-042 T-C1 — admin employee CRUD API contract', () => {
  it('POST /v1/employees creates and conforms to the Admin OpenAPI', async () => {
    const name = `Contract Test Employee ${randomUUID()}`;
    const response = await dispatchRequest('POST', '/v1/employees', { name }, await asAnyStaff(db));

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/employees', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('PUT /v1/employees/{employeeId}/capabilities conforms to the Admin OpenAPI', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Capability Target' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, {
      capabilities: ['finance-recorder'],
    }, await asAnyStaff(db));

    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/employees/{employeeId}/capabilities', 'put');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });
});

describe('STR-044 T-C1 — salary-payment capability gate (real claims-derivation) and posting', () => {
  // STR-045 changed this case's meaning, not just its expectation: an
  // anonymous caller is now 401 (we don't know who you are) rather than 403
  // (we do, and you may not) -- AC2. The 403 case it used to cover is still
  // covered, by the capability-holder-less token cases below.
  it('rejects a salary payment from an anonymous caller: 401 unauthorized', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'No Actor Payee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID() },
    );

    expect(response.status).toBe(401);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');

    // Known spec gap, now widened by this story: the Admin OpenAPI declares
    // neither a 403 nor a 401 response on this operation, though it marks the
    // whole surface `bearerAuth` -- so expectValidResponse can't be used for
    // either status. Asserted directly against the Error schema shape above
    // instead, same pattern as members.contract.test.ts's pinned
    // joining_date gap comment. Recorded as a G7 candidate in the PR body.
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(401, response.body)).toThrow(/no 401 response declared/);
  });

  it('rejects a salary payment for an actor without finance-recorder: 403', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Wrong Capability Payee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['data-entry'] }, await asAnyStaff(db));

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('capability_required');
  });

  it('records a salary payment for a finance-recorder-capable actor with an Idempotency-Key: 201 LedgerEntry', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Paid Employee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['finance-recorder'] }, await asAnyStaff(db));

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('rejects a salary payment with the capability present but no Idempotency-Key: 422', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'No Idempotency Payee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['finance-recorder'] }, await asAnyStaff(db));

    const response = await dispatchRequest(
      'POST',
      `/v1/employees/${employeeId}/salary-payments`,
      { method: 'bank', amount: '10000.00', period: '2026-07', paid_on: '2026-07-25' },
      { ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(422);
    const op = await contractTest('admin', '/employees/{employeeId}/salary-payments', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});

// STR-057 T-C3 — GET/PUT /v1/employees/{employeeId}/asset-view-grants
// admin API contract cases.
describe('STR-057 T-C3 — asset-view-grants API contract', () => {
  it('GET /v1/employees/{employeeId}/asset-view-grants returns an empty list by default', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Grants Target' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest('GET', `/v1/employees/${employeeId}/asset-view-grants`, {}, await asAnyStaff(db));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ project_ids: [] });

    const op = await contractTest('admin', '/employees/{employeeId}/asset-view-grants', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('GET /v1/employees/{employeeId}/asset-view-grants returns 404 for an unknown employee', async () => {
    const response = await dispatchRequest('GET', `/v1/employees/${randomUUID()}/asset-view-grants`, {}, await asAnyStaff(db));
    expect(response.status).toBe(404);

    const op = await contractTest('admin', '/employees/{employeeId}/asset-view-grants', 'get');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });

  it('PUT /v1/employees/{employeeId}/asset-view-grants replaces the grant set, conforming to the Admin OpenAPI', async () => {
    const projectResponse = await dispatchRequest('POST', '/v1/projects', { name: `Grants Contract Project ${randomUUID()}` }, await asAnyStaff(db));
    const projectId = (projectResponse.body as { project_id: string }).project_id;
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Grantable Employee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;
    await dispatchRequest('PUT', `/v1/employees/${employeeId}/capabilities`, { capabilities: ['data-entry'] }, await asAnyStaff(db));

    const response = await dispatchRequest(
      'PUT',
      `/v1/employees/${employeeId}/asset-view-grants`,
      { project_ids: [projectId] },
      await asSomeAuthenticatedStaff(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ project_ids: [projectId] });
    const op = await contractTest('admin', '/employees/{employeeId}/asset-view-grants', 'put');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('PUT /v1/employees/{employeeId}/asset-view-grants returns 422 for an employee with no admin account', async () => {
    const projectResponse = await dispatchRequest('POST', '/v1/projects', { name: `Grants Contract Project ${randomUUID()}` }, await asAnyStaff(db));
    const projectId = (projectResponse.body as { project_id: string }).project_id;
    const createResponse = await dispatchRequest('POST', '/v1/employees', { name: 'Undesignated Employee' }, await asAnyStaff(db));
    const employeeId = (createResponse.body as { employee_id: string }).employee_id;

    const response = await dispatchRequest(
      'PUT',
      `/v1/employees/${employeeId}/asset-view-grants`,
      { project_ids: [projectId] },
      await asSomeAuthenticatedStaff(),
    );
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/employees/{employeeId}/asset-view-grants', 'put');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});
