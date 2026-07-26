import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-043 T-C1 (covers TC-MEM-043) — GET/PUT /v1/projects/{projectId}/committee
// admin API contract cases. Same approach as test/contract/projects.contract.test.ts:
// dispatch the real handler against the singleton `db`, feed its response
// through the harness.
//
// The default ProjectOwnershipLookupPort stub (aws-blocks/projects/
// committees-api.ts) always answers `false`, so every PUT reachable through
// the wired route rejects with 422 until E06 replaces it (this story's own
// DoD: "no PC admin capability is introduced anywhere in the diff"). A
// successful PUT 200 is therefore exercised only at the unit level (test/
// projects/committees-api.test.ts), not here.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

describe('STR-043 T-C1 — admin project committee API contract (covers TC-MEM-043)', () => {
  it('GET /v1/projects/{projectId}/committee returns an empty composition conforming to the Admin OpenAPI', async () => {
    const createResponse = await dispatchRequest('POST', '/v1/projects', { name: `Committee Contract Project ${randomUUID()}` });
    const projectId = (createResponse.body as { project_id: string }).project_id;

    const response = await dispatchRequest('GET', `/v1/projects/${projectId}/committee`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ project_id: projectId, chair_member_id: null, member_ids: [], updated_at: null });

    const op = await contractTest('admin', '/projects/{projectId}/committee', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();
  });

  it('GET /v1/projects/{projectId}/committee returns 404 for a project that does not exist', async () => {
    const response = await dispatchRequest('GET', `/v1/projects/${randomUUID()}/committee`);
    expect(response.status).toBe(404);

    const op = await contractTest('admin', '/projects/{projectId}/committee', 'get');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });

  it('PUT /v1/projects/{projectId}/committee returns 404 for a project that does not exist', async () => {
    const response = await dispatchRequest('PUT', `/v1/projects/${randomUUID()}/committee`, {
      chair_member_id: randomUUID(),
      member_ids: [randomUUID()],
    });
    expect(response.status).toBe(404);

    const op = await contractTest('admin', '/projects/{projectId}/committee', 'put');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });

  it('PUT /v1/projects/{projectId}/committee returns 422 when a listed member is not active or owns nothing in the project', async () => {
    const createProjectResponse = await dispatchRequest('POST', '/v1/projects', { name: `Committee Contract Project ${randomUUID()}` });
    const projectId = (createProjectResponse.body as { project_id: string }).project_id;

    const createMemberResponse = await dispatchRequest('POST', '/v1/members', { name: 'Contract Test Candidate' });
    const memberId = (createMemberResponse.body as { member_id: string }).member_id;
    await dispatchRequest('POST', `/v1/members/${memberId}/admit`);

    // The member is now active, but the default ownership stub answers
    // false for every (member, project) pair -- so this is rejected as
    // owning nothing in the project.
    const response = await dispatchRequest('PUT', `/v1/projects/${projectId}/committee`, {
      chair_member_id: memberId,
      member_ids: [memberId],
    });
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/projects/{projectId}/committee', 'put');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});
