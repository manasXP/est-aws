import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff } from '../support/cognito-token';

// STR-053 — Admin API ownership allotment contract cases. Same approach as
// test/contract/assets.contract.test.ts: dispatch the real handler against
// the singleton `db`, feed its response through the harness.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createTestProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `Contract Test Project ${randomUUID()}` }, await asAnyStaff(db));
  return (response.body as { project_id: string }).project_id;
}

async function createTestMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `Contract Test Member ${randomUUID()}` }, await asAnyStaff(db));
  return (response.body as { member_id: string }).member_id;
}

async function createTestAsset(projectId: string, type = 'flat'): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type, label: type === 'dividend' ? undefined : 'A-1' }, await asAnyStaff(db));
  return (response.body as { asset_id: string }).asset_id;
}

describe('STR-053 T-C1 — Ownership schema carries asset_id, no embedded asset_type/asset_label', () => {
  it('POST /v1/members/{memberId}/ownerships returns a schema-valid Ownership referencing asset_id only', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);

    const response = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));

    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/members/{memberId}/ownerships', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();

    const body = response.body as Record<string, unknown>;
    expect(body.asset_id).toBe(assetId);
    expect(body).not.toHaveProperty('asset_type');
    expect(body).not.toHaveProperty('asset_label');
  });
});

describe('STR-053 (contract) — GET /v1/members/{memberId}/ownerships', () => {
  it('lists the member\'s ownerships, schema-valid', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));

    const listResponse = await dispatchRequest('GET', `/v1/members/${memberId}/ownerships`, {}, await asAnyStaff(db));
    const op = await contractTest('admin', '/members/{memberId}/ownerships', 'get');
    expect(() => op.expectValidResponse(listResponse.status, listResponse.body)).not.toThrow();
    expect((listResponse.body as { items: { asset_id: string }[] }).items.some(o => o.asset_id === assetId)).toBe(true);
  });
});

describe('STR-053 (contract) — PATCH /v1/ownerships/{ownershipId}', () => {
  it('updates co_owner_names, returning a schema-valid Ownership', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const createResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));
    const ownershipId = (createResponse.body as { ownership_id: string }).ownership_id;

    const patchResponse = await dispatchRequest('PATCH', `/v1/ownerships/${ownershipId}`, { co_owner_names: ['Priya Rao'] }, await asAnyStaff(db));
    const op = await contractTest('admin', '/ownerships/{ownershipId}', 'patch');
    expect(() => op.expectValidResponse(patchResponse.status, patchResponse.body)).not.toThrow();
    expect((patchResponse.body as { co_owner_names: string[] }).co_owner_names).toEqual(['Priya Rao']);
  });
});

describe('STR-053 code review — PATCH /v1/ownerships/{ownershipId} rejects a body carrying asset_id', () => {
  it('returns a schema-valid 422 Invalid response', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetA = await createTestAsset(projectId);
    const assetB = await createTestAsset(projectId);
    const createResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetA }, await asAnyStaff(db));
    const ownershipId = (createResponse.body as { ownership_id: string }).ownership_id;

    const response = await dispatchRequest('PATCH', `/v1/ownerships/${ownershipId}`, { asset_id: assetB }, await asAnyStaff(db));
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/ownerships/{ownershipId}', 'patch');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});

describe('STR-055 T-C (contract) — POST /v1/ownerships/{ownershipId}/transfer', () => {
  it('closes the old ownership and returns a schema-valid new Ownership (201)', async () => {
    const projectId = await createTestProject();
    const memberAId = await createTestMember();
    const memberBId = await createTestMember();
    await dispatchRequest('POST', `/v1/members/${memberBId}/admit`, {}, await asAnyStaff(db));
    const assetId = await createTestAsset(projectId);
    const createResponse = await dispatchRequest('POST', `/v1/members/${memberAId}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));
    const ownershipId = (createResponse.body as { ownership_id: string }).ownership_id;

    const response = await dispatchRequest('POST', `/v1/ownerships/${ownershipId}/transfer`, { to_member_id: memberBId }, await asAnyStaff(db));
    expect(response.status).toBe(201);
    const op = await contractTest('admin', '/ownerships/{ownershipId}/transfer', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();

    const body = response.body as { ownership_id: string; member_id: string; asset_id: string };
    expect(body.ownership_id).not.toBe(ownershipId);
    expect(body.member_id).toBe(memberBId);
    expect(body.asset_id).toBe(assetId);
  });

  it('returns a schema-valid 422 when the receiving member is not active', async () => {
    const projectId = await createTestProject();
    const memberAId = await createTestMember();
    const memberBId = await createTestMember(); // left pending -- not admitted
    const assetId = await createTestAsset(projectId);
    const createResponse = await dispatchRequest('POST', `/v1/members/${memberAId}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));
    const ownershipId = (createResponse.body as { ownership_id: string }).ownership_id;

    const response = await dispatchRequest('POST', `/v1/ownerships/${ownershipId}/transfer`, { to_member_id: memberBId }, await asAnyStaff(db));
    expect(response.status).toBe(422);
    const op = await contractTest('admin', '/ownerships/{ownershipId}/transfer', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });

  it('returns a schema-valid 404 for a nonexistent ownership', async () => {
    const memberId = await createTestMember();
    const response = await dispatchRequest('POST', '/v1/ownerships/no-such-ownership/transfer', { to_member_id: memberId }, await asAnyStaff(db));
    expect(response.status).toBe(404);
    const op = await contractTest('admin', '/ownerships/{ownershipId}/transfer', 'post');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });
});

describe('STR-053 (contract) — POST /v1/members/{memberId}/ownerships rejects double allotment', () => {
  it('returns a schema-valid 409 Conflict response', async () => {
    const projectId = await createTestProject();
    const memberA = await createTestMember();
    const memberB = await createTestMember();
    const assetId = await createTestAsset(projectId);
    await dispatchRequest('POST', `/v1/members/${memberA}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));

    const response = await dispatchRequest('POST', `/v1/members/${memberB}/ownerships`, { asset_id: assetId }, await asAnyStaff(db));
    expect(response.status).toBe(409);

    const op = await contractTest('admin', '/members/{memberId}/ownerships', 'post');
    expect(() => op.expectValidResponse(409, response.body)).not.toThrow();
  });
});
