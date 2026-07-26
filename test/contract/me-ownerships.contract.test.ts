import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-057 T-C1 (covers TC-AST-040) — mobile GET /me/ownerships contract
// cases. Same approach as test/contract/ownerships.contract.test.ts:
// dispatch the real handler against the singleton `db`, feed its response
// through the harness. This is the first mobile self-service (`/me`)
// endpoint built in this repo -- caller identity is resolved from the
// X-Actor-Member-Id stub header, the same convention capability-gate.ts
// established for the Admin API.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createTestProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `Contract Test Project ${randomUUID()}` });
  return (response.body as { project_id: string }).project_id;
}

async function createTestMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `Contract Test Member ${randomUUID()}` });
  return (response.body as { member_id: string }).member_id;
}

async function createTestAsset(projectId: string, type = 'flat'): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type, label: 'A-1' });
  return (response.body as { asset_id: string }).asset_id;
}

describe('STR-057 T-C1 — GET /v1/me/ownerships (covers TC-AST-040)', () => {
  it('embeds each ownership\'s asset detail and returns only the caller\'s own assets', async () => {
    const projectId = await createTestProject();
    const memberA = await createTestMember();
    const memberB = await createTestMember();
    const assetA = await createTestAsset(projectId, 'flat');
    const assetB = await createTestAsset(projectId, 'plot');
    await dispatchRequest('POST', `/v1/members/${memberA}/ownerships`, { asset_id: assetA });
    await dispatchRequest('POST', `/v1/members/${memberB}/ownerships`, { asset_id: assetB });

    const response = await dispatchRequest('GET', '/v1/me/ownerships', {}, { 'X-Actor-Member-Id': memberA });

    expect(response.status).toBe(200);
    const op = await contractTest('mobile', '/me/ownerships', 'get');
    expect(() => op.expectValidResponse(200, response.body)).not.toThrow();

    const items = (response.body as { items: { asset: { asset_id: string; type: string; status: string } } }[] & { items: unknown[] })
      .items as { asset: { asset_id: string; type: string; status: string } }[];
    expect(items).toHaveLength(1);
    expect(items[0].asset.asset_id).toBe(assetA);
    expect(items[0].asset.type).toBe('flat');
    expect(items[0].asset.status).toBe('allotted');
  });

  // Genuine Red gap: no TC covers unauthenticated access, but this is the
  // first mobile self-service endpoint built in this repo -- a defined
  // 401, not a crash or a leaked empty list, is the only safe default for
  // a missing X-Actor-Member-Id header.
  it('returns 401 when no caller identity is presented', async () => {
    const response = await dispatchRequest('GET', '/v1/me/ownerships');
    expect(response.status).toBe(401);

    const op = await contractTest('mobile', '/me/ownerships', 'get');
    expect(() => op.expectValidResponse(401, response.body)).not.toThrow();
  });
});
