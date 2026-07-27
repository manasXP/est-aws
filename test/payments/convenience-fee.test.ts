import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { initiatePayment } from '../../aws-blocks/payments/payment-initiation';
import { computeConvenienceFee } from '../../aws-blocks/payments/convenience-fee';
import { FakePaymentProvider } from '../../aws-blocks/payments/fake-payment-provider';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { parseMoney } from '../../aws-blocks/money';

// STR-093 -- convenience fee itemization (T-U1/T-U2/T-U4, covers TC-PAY-023,
// TC-PAY-024). Follows STR-092's test/payments/payment-initiation.test.ts
// pattern: fresh Database + Scope per test, baseline + domain migrations
// applied via MIGRATIONS_DIR. T-U3 (the status-polling case) lives in
// test/contract/me-payments.contract.test.ts, since it exercises the real
// GET /v1/me/payments/{paymentId} route.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-093-convenience-fee-test-${randomUUID()}`), 'db');
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
 * endpoint (the charge run is the only writer), same as
 * test/payments/payment-initiation.test.ts's own seedCharge helper. */
async function seedCharge(db: Database, memberId: string, ownershipId: string, amount: string): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${memberId}, ${ownershipId}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

/** payment_settings is a singleton configured directly by SQL, no HTTP
 * endpoint (this story's own note) -- tests configure it the same way. */
async function setPaymentSettings(
  db: Database,
  { convenienceFeePercent, absorbFees }: { convenienceFeePercent: string; absorbFees: boolean },
): Promise<void> {
  await db.execute(
    sql`UPDATE payment_settings SET convenience_fee_percent = ${convenienceFeePercent}::numeric, absorb_fees = ${absorbFees} WHERE id = 'default'`,
  );
}

describe('STR-093 T-U1 -- card/netbanking itemizes the convenience fee, UPI never carries one (covers TC-PAY-023)', () => {
  it('itemizes the fee into the checkout total the provider is asked to charge for card', async () => {
    const db = await freshMigratedDb();
    await setPaymentSettings(db, { convenienceFeePercent: '2.50', absorbFees: false });
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const chargeId = await seedCharge(db, memberId, ownershipId, '1000.00');
    const provider = new FakePaymentProvider();

    const result = await initiatePayment(db, provider, memberId, [chargeId], 'card', randomUUID());

    // 1000.00 * 2.5% = 25.00 exactly.
    expect(result.amount).toBe('1025.00');
    expect(provider.createdIntents).toHaveLength(1);
    expect(provider.createdIntents[0].params.amount).toBe('1025.00');
  });

  it('carries no fee over UPI regardless of the society configuration (fee rate is non-zero)', async () => {
    const db = await freshMigratedDb();
    await setPaymentSettings(db, { convenienceFeePercent: '2.50', absorbFees: false });
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const chargeId = await seedCharge(db, memberId, ownershipId, '1000.00');
    const provider = new FakePaymentProvider();

    const result = await initiatePayment(db, provider, memberId, [chargeId], 'upi', randomUUID());

    expect(result.amount).toBe('1000.00');
    expect(provider.createdIntents[0].params.amount).toBe('1000.00');
  });
});

describe('STR-093 T-U2 -- absorb-fees toggle removes the fee from what the member is charged (covers TC-PAY-024)', () => {
  it('charges the provider the base amount, with no fee, when absorb_fees is true', async () => {
    const db = await freshMigratedDb();
    await setPaymentSettings(db, { convenienceFeePercent: '2.50', absorbFees: true });
    const { memberId, ownershipId } = await seedMemberWithOwnership(db);
    const chargeId = await seedCharge(db, memberId, ownershipId, '1000.00');
    const provider = new FakePaymentProvider();

    const result = await initiatePayment(db, provider, memberId, [chargeId], 'card', randomUUID());

    expect(result.amount).toBe('1000.00');
    expect(provider.createdIntents[0].params.amount).toBe('1000.00');
  });
});

describe('STR-093 T-U4 -- exact-decimal, round-half-up fee computation, never a float', () => {
  it('rounds a fee that does not divide evenly to the nearest paisa deterministically', async () => {
    const db = await freshMigratedDb();
    await setPaymentSettings(db, { convenienceFeePercent: '1.15', absorbFees: false });

    const { fee, totalAmount } = await computeConvenienceFee(db, 'card', '999.99');

    // basePaise = 99999, percentHundredths = 115 -> scaled = 11499885;
    // q = 1149, r = 9885; r*2 = 19770 >= 10000 -> rounds up to 1150 paise = 11.50.
    expect(fee).toBe('11.50');
    expect(totalAmount).toBe('1011.49');
    expect(parseMoney(fee) + parseMoney('999.99')).toBe(parseMoney(totalAmount));
  });
});
