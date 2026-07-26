import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-051 — Admin API asset registry contract cases. Same approach as
// test/contract/projects.contract.test.ts: dispatch the real handler
// against the singleton `db`, feed its response through the harness.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createTestProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `Contract Test Project ${randomUUID()}` });
  return (response.body as { project_id: string }).project_id;
}

describe('STR-051 T-C1 — admin asset registry API contract', () => {
  it('POST /v1/assets creates an asset conforming to the Admin OpenAPI', async () => {
    const projectId = await createTestProject();
    const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'flat', label: 'A-204' });

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/assets', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();
    expect((response.body as { current_ownership_id: unknown }).current_ownership_id).toBeNull();
  });

  it('GET /v1/assets lists the created asset', async () => {
    const projectId = await createTestProject();
    const createResponse = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'plot' });
    const assetId = (createResponse.body as { asset_id: string }).asset_id;

    const listResponse = await dispatchRequest('GET', '/v1/assets');
    const op = await contractTest('admin', '/assets', 'get');
    expect(() => op.expectValidResponse(listResponse.status, listResponse.body)).not.toThrow();
    expect((listResponse.body as { items: { asset_id: string }[] }).items.some(a => a.asset_id === assetId)).toBe(true);
  });
});

// Genuine Red gap, same rationale as the unit test's T-U4: Green requires a
// PATCH handler but no T-C case in the story text names it.
describe('STR-051 T-U4 (contract) — PATCH /v1/assets/{assetId}', () => {
  it('edits label/status and returns a schema-valid Asset', async () => {
    const projectId = await createTestProject();
    const createResponse = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'villa', label: 'V-1' });
    const assetId = (createResponse.body as { asset_id: string }).asset_id;

    const patchResponse = await dispatchRequest('PATCH', `/v1/assets/${assetId}`, { label: 'V-2', status: 'society_retained' });
    const op = await contractTest('admin', '/assets/{assetId}', 'patch');
    expect(() => op.expectValidResponse(patchResponse.status, patchResponse.body)).not.toThrow();
    expect((patchResponse.body as { label: string }).label).toBe('V-2');
  });
});

describe('STR-051 code review — POST /v1/assets rejects an invalid type', () => {
  it('returns 422 conforming to the Admin OpenAPI Invalid response', async () => {
    const projectId = await createTestProject();
    const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'penthouse' });
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/assets', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});
