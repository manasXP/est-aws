import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-057 T-C2 (covers TC-AST-041) — mobile GET /pc/projects/{projectId}/assets
// contract cases. Same dispatch-the-real-handler approach as the other
// contract suites.
//
// The wired PUT /v1/projects/{projectId}/committee route always answers 422
// (STR-043: its ownershipLookup stub always returns false, still true as of
// this story -- test/contract/committees.contract.test.ts's own comment).
// A real PC can only be seated by calling setProjectCommittee directly with
// a permissive lookup, the same way test/projects/committees-api.test.ts
// does -- bypassing HTTP for setup only; the assertion itself always goes
// through the real GET /v1/pc/... handler.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createTestProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `Contract Test Project ${randomUUID()}` });
  return (response.body as { project_id: string }).project_id;
}

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `Contract Test Member ${randomUUID()}` });
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`);
  return memberId;
}

async function createTestAsset(projectId: string, type = 'flat'): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type, label: 'A-1' });
  return (response.body as { asset_id: string }).asset_id;
}

async function seatPc(projectId: string, memberIds: string[]): Promise<void> {
  await setProjectCommittee(
    db,
    projectId,
    { chair_member_id: memberIds[0], member_ids: memberIds },
    { ownershipLookup: async () => true },
  );
}

describe('STR-057 T-C2 — GET /v1/pc/projects/{projectId}/assets (covers TC-AST-041)', () => {
  it('returns the project\'s full registry, including unowned assets, with current-owner identity, for a PC member', async () => {
    const projectId = await createTestProject();
    const pcMember = await createActiveMember();
    const owner = await createActiveMember();
    await seatPc(projectId, [pcMember]);

    const ownedAsset = await createTestAsset(projectId, 'flat');
    const unownedAsset = await createTestAsset(projectId, 'plot');
    await dispatchRequest('POST', `/v1/members/${owner}/ownerships`, { asset_id: ownedAsset });

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/assets`, {}, { 'X-Actor-Member-Id': pcMember });

    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/pc/projects/{projectId}/assets', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();

    const items = (response.body as { items: { asset_id: string; current_owner: { member_id: string } | null }[] }).items;
    expect(items.map(a => a.asset_id).sort()).toEqual([ownedAsset, unownedAsset].sort());
    expect(items.find(a => a.asset_id === ownedAsset)?.current_owner).toEqual({ member_id: owner, name: expect.any(String) });
    expect(items.find(a => a.asset_id === unownedAsset)?.current_owner).toBeNull();
  });

  it('rejects a non-PC caller with 403', async () => {
    const projectId = await createTestProject();
    const pcMember = await createActiveMember();
    const outsider = await createActiveMember();
    await seatPc(projectId, [pcMember]);

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/assets`, {}, { 'X-Actor-Member-Id': outsider });
    expect(response.status).toBe(403);

    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('capability_required');
  });

  // Genuine Red gap: the OpenAPI declares 404 for an unknown project, not
  // itself named by the story's T-C2 text.
  it('returns 404 for a project that does not exist', async () => {
    const response = await dispatchRequest('GET', `/v1/pc/projects/${randomUUID()}/assets`, {}, { 'X-Actor-Member-Id': randomUUID() });
    expect(response.status).toBe(404);

    const op = await contractTest('mobile', '/pc/projects/{projectId}/assets', 'get');
    expect(() => op.expectValidResponse(404, response.body)).not.toThrow();
  });
});
