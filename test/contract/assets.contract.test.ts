import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

async function createTestMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `Contract Test Member ${randomUUID()}` });
  return (response.body as { member_id: string }).member_id;
}

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

describe('STR-053 code review — PATCH /v1/assets/{assetId} rejects a status change on an allotted asset', () => {
  it('returns a schema-valid 409 Conflict response', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const createResponse = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'flat', label: 'A-301' });
    const assetId = (createResponse.body as { asset_id: string }).asset_id;
    await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });

    const response = await dispatchRequest('PATCH', `/v1/assets/${assetId}`, { status: 'society_retained' });
    expect(response.status).toBe(409);

    const op = await contractTest('admin', '/assets/{assetId}', 'patch');
    expect(() => op.expectValidResponse(409, response.body)).not.toThrow();
  });
});

describe('STR-055 T-C (contract) — GET /v1/assets/{assetId} returns AssetDetail with owner history', () => {
  it('is schema-valid and lists the transfer chain newest first', async () => {
    const projectId = await createTestProject();
    const memberAId = await createTestMember();
    const memberBId = await createTestMember();
    await dispatchRequest('POST', `/v1/members/${memberBId}/admit`, {});
    const createResponse = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'flat', label: 'A-401' });
    const assetId = (createResponse.body as { asset_id: string }).asset_id;
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberAId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    await dispatchRequest('POST', `/v1/ownerships/${ownershipId}/transfer`, { to_member_id: memberBId });

    const response = await dispatchRequest('GET', `/v1/assets/${assetId}`);
    expect(response.status).toBe(200);
    const op = await contractTest('admin', '/assets/{assetId}', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();

    const body = response.body as { owner_history: { member_id: string; to: string | null }[] };
    expect(body.owner_history).toHaveLength(2);
    expect(body.owner_history[0].member_id).toBe(memberBId);
    expect(body.owner_history[0].to).toBeNull();
    expect(body.owner_history[1].member_id).toBe(memberAId);
    expect(body.owner_history[1].to).not.toBeNull();
  });

  it('returns a schema-valid 404 for a nonexistent asset', async () => {
    const response = await dispatchRequest('GET', '/v1/assets/no-such-asset');
    expect(response.status).toBe(404);
    const op = await contractTest('admin', '/assets/{assetId}', 'get');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });
});

describe('STR-053 code review — GET /v1/assets reports the real current_ownership_id once allotted', () => {
  it('is null for a freshly-created asset and the ownership id once allotted', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const createResponse = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'flat', label: 'A-302' });
    const assetId = (createResponse.body as { asset_id: string }).asset_id;
    expect((createResponse.body as { current_ownership_id: unknown }).current_ownership_id).toBeNull();

    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;

    const listResponse = await dispatchRequest('GET', '/v1/assets');
    const op = await contractTest('admin', '/assets', 'get');
    expect(() => op.expectValidResponse(listResponse.status, listResponse.body)).not.toThrow();
    const listed = (listResponse.body as { items: { asset_id: string; current_ownership_id: unknown }[] }).items.find(
      a => a.asset_id === assetId,
    );
    expect(listed?.current_ownership_id).toBe(ownershipId);
  });
});
