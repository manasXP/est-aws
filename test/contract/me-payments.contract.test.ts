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
  return seedCharge(memberId, ownershipId, 'due');
}

async function seedCharge(memberId: string, ownershipId: string, status: 'due' | 'paid' | 'in_payment'): Promise<string> {
  const chargeId = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${chargeId}, ${memberId}, ${ownershipId}, '1250.00', '2026-08-01', ${status})`,
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
      { charge_ids: [chargeId], payment_method: 'upi' },
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

// Review-fix -- the OpenAPI spec declares a 409 ("A charge is not payable
// (already paid, or in-flight under another payment).") distinct from the
// 422 ("Unknown charge id, or charge not owned by this member.") for this
// endpoint. This exercises the 409 case end-to-end through the route.
describe('STR-092 review fix -- POST /v1/me/payments against an already-paid charge', () => {
  it('returns 409 charge_already_locked, validating against the OpenAPI schema', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedCharge(memberId, ownershipId, 'paid');

    const response = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId], payment_method: 'upi' },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': randomUUID() },
    );

    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('charge_already_locked');
    const op = await contractTest('mobile', '/me/payments', 'post');
    expect(() => op.expectValidResponse(409, response.body)).not.toThrow();
  });
});

// Review-fix -- the OpenAPI spec requires `minItems: 1` on `charge_ids`; an
// empty array must be rejected before initiatePayment ever runs (it
// previously passed vacuously and created a zero-charge, zero-amount
// payment_intents row).
describe('STR-092 review fix -- POST /v1/me/payments with an empty charge_ids array', () => {
  it('returns 422 without creating a payment_intents row', async () => {
    const memberId = await createTestMember();
    const idempotencyKey = randomUUID();

    const response = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [] },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(422);
    const op = await contractTest('mobile', '/me/payments', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();

    const rows = await db.query(sql`SELECT id FROM payment_intents WHERE idempotency_key = ${idempotencyKey}`);
    expect(rows).toHaveLength(0);
  });
});

// Review-fix (money-correctness bug) -- payment_method was previously read
// with no presence/enum check at all and passed straight into
// computeConvenienceFee, which only treats the literal string 'upi' as
// fee-free; anything else (undefined, or garbage like 'cash') fell through to
// the fee-charging branch. The Mobile OpenAPI request schema for this
// endpoint only documents `charge_ids` -- a spec-compliant client cannot even
// send `payment_method` -- so every real request would have been silently
// overcharged once a society configures a nonzero convenience-fee rate.
// These two cases confirm the fix: missing, and a non-enum value, both 422
// before initiatePayment/computeConvenienceFee ever run, with nothing
// written -- same atomicity posture as the empty-charge_ids case above.
describe('STR-093 review fix -- POST /v1/me/payments requires a valid payment_method (money-correctness)', () => {
  it('returns 422 with no payment_method at all, writing nothing', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedDueCharge(memberId, ownershipId);
    const idempotencyKey = randomUUID();

    const response = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId] },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(422);
    const op = await contractTest('mobile', '/me/payments', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();

    const rows = await db.query(sql`SELECT id FROM payment_intents WHERE idempotency_key = ${idempotencyKey}`);
    expect(rows).toHaveLength(0);
    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('due');
  });

  it("returns 422 for a garbage payment_method value ('cash'), writing nothing", async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedDueCharge(memberId, ownershipId);
    const idempotencyKey = randomUUID();

    const response = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId], payment_method: 'cash' },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': idempotencyKey },
    );

    expect(response.status).toBe(422);
    const op = await contractTest('mobile', '/me/payments', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();

    const rows = await db.query(sql`SELECT id FROM payment_intents WHERE idempotency_key = ${idempotencyKey}`);
    expect(rows).toHaveLength(0);
    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('due');
  });
});

// STR-093 T-U3 (covers TC-PAY-043) -- GET /v1/me/payments/{paymentId} reflects
// only webhook-confirmed status. This story never writes a webhook, so a
// payment freshly initiated and polled repeatedly must show `pending` on
// every poll -- there is no code path in this GET route by which a client
// could transition it to `succeeded` (the route parses no request body at
// all).
describe('STR-093 T-U3 -- GET /v1/me/payments/{paymentId} polls pending with no webhook ever delivered (covers TC-PAY-043)', () => {
  it('returns 200 status pending on every poll', async () => {
    const projectId = await createTestProject();
    const memberId = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberId}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedDueCharge(memberId, ownershipId);

    const initiateResponse = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId], payment_method: 'upi' },
      { 'X-Actor-Member-Id': memberId, 'Idempotency-Key': randomUUID() },
    );
    expect(initiateResponse.status).toBe(201);
    const paymentId = (initiateResponse.body as { payment_id: string }).payment_id;

    const op = await contractTest('mobile', '/me/payments/{paymentId}', 'get');

    for (let i = 0; i < 2; i++) {
      const pollResponse = await dispatchRequest(
        'GET',
        `/v1/me/payments/${paymentId}`,
        undefined,
        { 'X-Actor-Member-Id': memberId },
      );
      expect(pollResponse.status).toBe(200);
      expect((pollResponse.body as { status: string }).status).toBe('pending');
      expect(() => op.expectValidResponse(200, pollResponse.body)).not.toThrow();
    }
  });
});

// Review-fix (test-coverage gap) -- getPaymentStatus's ownership scoping
// (`WHERE id = ... AND member_id = ...`) is implemented correctly, but no
// test exercised it: a payment belonging to a different member must 404
// identically to a genuinely nonexistent payment id (no ownership leak via a
// distinct status/body shape for "exists but not yours" vs "doesn't exist").
describe('STR-093 review fix -- GET /v1/me/payments/{paymentId} ownership scoping', () => {
  it('404s identically for another member\'s real payment and a nonexistent payment id', async () => {
    const projectId = await createTestProject();
    const memberA = await createTestMember();
    const memberB = await createTestMember();
    const assetId = await createTestAsset(projectId);
    const ownershipResponse = await dispatchRequest('POST', `/v1/members/${memberA}/ownerships`, { asset_id: assetId });
    const ownershipId = (ownershipResponse.body as { ownership_id: string }).ownership_id;
    const chargeId = await seedDueCharge(memberA, ownershipId);

    const initiateResponse = await dispatchRequest(
      'POST',
      '/v1/me/payments',
      { charge_ids: [chargeId], payment_method: 'upi' },
      { 'X-Actor-Member-Id': memberA, 'Idempotency-Key': randomUUID() },
    );
    expect(initiateResponse.status).toBe(201);
    const paymentId = (initiateResponse.body as { payment_id: string }).payment_id;

    const op = await contractTest('mobile', '/me/payments/{paymentId}', 'get');

    const foreignResponse = await dispatchRequest('GET', `/v1/me/payments/${paymentId}`, undefined, { 'X-Actor-Member-Id': memberB });
    const missingResponse = await dispatchRequest('GET', `/v1/me/payments/${randomUUID()}`, undefined, { 'X-Actor-Member-Id': memberB });

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(foreignResponse.body).toEqual(missingResponse.body);
    expect(() => op.expectValidResponse(404, foreignResponse.body)).not.toThrow();
  });
});
