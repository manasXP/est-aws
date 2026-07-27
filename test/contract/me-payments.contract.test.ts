import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-092 T-U1 (covers TC-PAY-020) -- mobile POST /me/payments contract case.
// Same approach as test/contract/me-ownerships.contract.test.ts: dispatch the
// real handler against the singleton `db`, feed its response through the
// harness.

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

async function createTestAsset(projectId: string): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/assets', { project_id: projectId, type: 'flat', label: 'A-1' });
  return (response.body as { asset_id: string }).asset_id;
}

/** Seeded directly via SQL -- there is no charge-creation HTTP endpoint (the
 * charge run is the only writer), same as the payment-initiation unit tests. */
async function seedDueCharge(memberId: string, ownershipId: string): Promise<string> {
  const chargeId = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${chargeId}, ${memberId}, ${ownershipId}, '1250.00', '2026-08-01', 'due')`,
  );
  return chargeId;
}

describe('STR-092 T-U1 -- POST /v1/me/payments (covers TC-PAY-020)', () => {
  it('locks the named due charge and returns the mobile PaymentIntent shape', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedDueCharge(memberId, ownershipId);

    const response = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId] },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': randomUUID() },
    );

    expect(response.status).toBe(201);
    const op = await contractTest('mobile', '/me/payments', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();

    const body = response.body as { payment_id: string; provider: string; provider_params: Record<string, unknown> };
    expect(body.payment_id).toBeTruthy();
    expect(body.provider).toBe('razorpay');
    expect(body.provider_params).toBeTruthy();

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('in_payment');
  });
});
