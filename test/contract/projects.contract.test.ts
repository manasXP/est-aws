import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff } from '../support/cognito-token';

// STR-031 — Admin API project CRUD contract cases. Same approach as
// test/contract/members.contract.test.ts and test/contract/books.contract.test.ts:
// dispatch the real handler against the singleton `db`, feed its response
// through the harness.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

describe('STR-031 T-C2 — admin project CRUD API contract', () => {
  it('POST /v1/projects creates a project conforming to the Admin OpenAPI', async () => {
    const name = `Contract Test Project ${randomUUID()}`;
    const response = await dispatchRequest('POST', '/v1/projects', { name, description: 'A test project' }, await asAnyStaff(db));

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/projects', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
  });

  it('GET /v1/projects lists the created project', async () => {
    const name = `Contract Test Project For List ${randomUUID()}`;
    const createResponse = await dispatchRequest('POST', '/v1/projects', { name }, await asAnyStaff(db));
    const projectId = (createResponse.body as { project_id: string }).project_id;

    const listResponse = await dispatchRequest('GET', '/v1/projects', {}, await asAnyStaff(db));
    const op = await contractTest('admin', '/projects', 'get');
    expect(() => op.expectValidResponse(listResponse.status, listResponse.body)).not.toThrow();
    expect((listResponse.body as { items: { project_id: string }[] }).items.some(p => p.project_id === projectId)).toBe(true);
  });

  it('GET /v1/projects/{projectId} and PATCH conform to the Admin OpenAPI', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/projects', { name: `Patchable Project ${randomUUID()}` }, await asAnyStaff(db));
    const projectId = (createResponse.body as { project_id: string }).project_id;

    const getResponse = await dispatchRequest('GET', `/v1/projects/${projectId}`, {}, await asAnyStaff(db));
    const getOp = await contractTest('admin', '/projects/{projectId}', 'get');
    expect(() => getOp.expectValidResponse(getResponse.status, getResponse.body)).not.toThrow();

    const patchResponse = await dispatchRequest('PATCH', `/v1/projects/${projectId}`, { description: 'Updated description' }, await asAnyStaff(db));
    const patchOp = await contractTest('admin', '/projects/{projectId}', 'patch');
    expect(() => patchOp.expectValidResponse(patchResponse.status, patchResponse.body)).not.toThrow();
    expect((patchResponse.body as { description: string }).description).toBe('Updated description');
  });
});

describe('STR-031 code review — POST /v1/projects rejects a missing name', () => {
  it('returns 422 conforming to the Admin OpenAPI Invalid response', async () => {
    const response = await dispatchRequest('POST', '/v1/projects', { description: 'No name here' }, await asAnyStaff(db));
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/projects', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});
