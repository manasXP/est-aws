import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { initiatePayment, ChargeNotPayableError, ChargeAlreadyLockedError } from '../../aws-blocks/payments/payment-initiation';
import { FakePaymentProvider } from '../../aws-blocks/payments/fake-payment-provider';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-092 -- payment initiation with idempotent charge locking. T-U2 through
// T-U5 exercise aws-blocks/payments/payment-initiation.ts directly, no HTTP
// dispatch (T-U1's contract case lives in
// test/contract/me-payments.contract.test.ts). Follows the STR-061 test
// pattern (test/payments/charge-run.test.ts): fresh Database + Scope per
// test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-092-payment-initiation-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

async function seedMemberWithOwnership(db: Database): Promise<{ memberId: string; ownershipId: string }> {
  const project = await createProject(db, { name: 'Green Meadows' });
  const member = await createMember(db, { name: 'Asha Rao' });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  return { memberId: member.member_id, ownershipId: ownership.ownership_id };
}

/** Tests seed a charge directly via SQL -- there is no charge-creation HTTP
 * endpoint (the charge run is the only writer), same as test/assets/
 * ownerships-api.test.ts's own seedCharge helper. */
async function seedCharge(
  db: Database,
  memberId: string,
  ownershipId: string,
  status: 'due' | 'in_payment' | 'paid',
  amount = '1250.00',
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${memberId}, ${ownershipId}, ${amount}, '2026-08-01', ${status})`,
  );
  return id;
}

describe('STR-092 T-U2 -- idempotent replay of the same Idempotency-Key (covers TC-PAY-021)', () => {
  it('returns the identical payment_id, with no second payment_intents row and no double lock', async () => {
    const db = await freshMigratedDb();
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const chargeId = await seedCharge(db, memberId, ownershipId, 'due');
    const provider = new FakePaymentProvider();
    const idempotencyKey = randomUUID();

    const first = await initiatePayment(db, provider, memberId, [chargeId], 'upi', idempotencyKey);
    const second = await initiatePayment(db, provider, memberId, [chargeId], 'upi', idempotencyKey);

    expect(second.paymentId).toBe(first.paymentId);
    const rows = await db.query(sql`SELECT id FROM payment_intents WHERE idempotency_key = ${idempotencyKey}`);
    expect(rows).toHaveLength(1);
    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('in_payment');
    // Only the first call should have ever asked the provider to create an intent.
    expect(provider.createdIntents).toHaveLength(1);
  });
});

// Covers TC-PAY-022's "already paid or in_payment" case. Note: TC-PAY-022's
// own wording says code `charge_not_payable`, but the Mobile API's OpenAPI
// spec (mobile/openapi.yaml POST /me/payments) declares this specific case
// -- a named charge that exists and is owned by the caller but isn't `due`
// -- as its own 409 response ("A charge is not payable (already paid, or
// in-flight under another payment)"), distinct from the 422 "unknown charge
// id, or charge not owned by this member" case. The OpenAPI contract is the
// source of truth here, so this test (and the route) asserts 409/
// charge_already_locked, not 422/charge_not_payable -- see T-U4 below for
// the 422 case this endpoint still has.
describe('STR-092 T-U3 -- one due charge + one unpayable charge fails the whole request atomically (covers TC-PAY-022)', () => {
  it('rejects with ChargeAlreadyLockedError and leaves the due charge unlocked', async () => {
    const db = await freshMigratedDb();
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const dueChargeId = await seedCharge(db, memberId, ownershipId, 'due');
    const paidChargeId = await seedCharge(db, memberId, ownershipId, 'paid');
    const provider = new FakePaymentProvider();

    await expect(
      initiatePayment(db, provider, memberId, [dueChargeId, paidChargeId], 'upi', randomUUID()),
    ).rejects.toThrow(ChargeAlreadyLockedError);

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${dueChargeId}`);
    expect(charge!.status).toBe('due');
    expect(provider.createdIntents).toHaveLength(0);
  });
});

describe('STR-092 T-U4 -- a charge belonging to a different member is rejected identically to a nonexistent one', () => {
  it('both fail with the same ChargeNotPayableError message, no ownership/existence leak', async () => {
    const db = await freshMigratedDb();
    const { memberId: callerId } = await seedMemberWithOwnership(db);
    const { memberId: otherMemberId, ownershipId: otherOwnershipId } = await seedMemberWithOwnership(db);
    const foreignChargeId = await seedCharge(db, otherMemberId, otherOwnershipId, 'due');
    const provider = new FakePaymentProvider();

    const foreignError = await initiatePayment(db, provider, callerId, [foreignChargeId], 'upi', randomUUID()).catch(e => e);
    const missingError = await initiatePayment(db, provider, callerId, [randomUUID()], 'upi', randomUUID()).catch(e => e);

    expect(foreignError).toBeInstanceOf(ChargeNotPayableError);
    expect(missingError).toBeInstanceOf(ChargeNotPayableError);
    expect(foreignError.message).toBe(missingError.message);
    expect(provider.createdIntents).toHaveLength(0);
  });
});

describe('STR-092 T-U5 -- concurrent identical Idempotency-Key retry resolves to one payment_intents row', () => {
  it('both concurrent calls resolve to the same paymentId', async () => {
    const db = await freshMigratedDb();
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const chargeId = await seedCharge(db, memberId, ownershipId, 'due');
    const provider = new FakePaymentProvider();
    const idempotencyKey = randomUUID();

    const [a, b] = await Promise.all([
      initiatePayment(db, provider, memberId, [chargeId], 'upi', idempotencyKey),
      initiatePayment(db, provider, memberId, [chargeId], 'upi', idempotencyKey),
    ]);

    expect(a.paymentId).toBe(b.paymentId);
    const rows = await db.query(sql`SELECT id FROM payment_intents WHERE idempotency_key = ${idempotencyKey}`);
    expect(rows).toHaveLength(1);
  });
});
