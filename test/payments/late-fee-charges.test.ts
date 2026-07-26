import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun, runLateFeeSweep, type Charge } from '../../aws-blocks/payments/charges';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-065 — late-fee charges from per-society rules. Same freshMigratedDb()/
// setMaintenanceFee() pattern as test/payments/charge-run.test.ts (STR-061);
// no HTTP endpoint in this story either, so late-fee config is set via
// direct SQL like the maintenance fee.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-065-charges-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

async function setMaintenanceFee(db: Database, fee: string): Promise<void> {
  await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${fee} WHERE id = 'default'`);
}

async function setLateFeeConfig(db: Database, amount: string, gracePeriodDays: number): Promise<void> {
  await db.execute(
    sql`UPDATE charge_settings SET late_fee_amount = ${amount}, late_fee_grace_period_days = ${gracePeriodDays} WHERE id = 'default'`,
  );
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

/** Seeds a single accruing member/asset/ownership and raises its one
 * "maintenance" source charge via the real run, so the source charge is a
 * realistic row (not hand-inserted) exactly as STR-061's own tests do. */
async function seedSourceCharge(
  db: Database,
  opts: { maintenanceFee: string; periodKey: string; dueDate: string },
): Promise<Charge> {
  await setMaintenanceFee(db, opts.maintenanceFee);
  const project = await createProject(db, { name: 'Green Meadows' });
  const member = await createMember(db, { name: 'Asha Rao' });
  await admitMember(db, member.member_id);
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
  await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  const charges = await runMaintenanceChargeRun(db, opts.periodKey, opts.dueDate);
  expect(charges).toHaveLength(1);
  return charges[0];
}

describe('STR-065 T-U1 — an overdue maintenance charge raises a separate late-fee charge (covers TC-PAY-003)', () => {
  it('raises one "150.00" late_fee charge linked to the source, leaving the original charge byte-for-byte unmodified', async () => {
    const db = await freshMigratedDb();
    const source = await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-06', dueDate: '2026-06-05' });
    await setLateFeeConfig(db, '150.00', 5); // due 2026-06-05 + 5 days grace = 2026-06-10

    const lateFees = await runLateFeeSweep(db, '2026-07', '2026-07-15');

    expect(lateFees).toHaveLength(1);
    expect(lateFees[0].kind).toBe('late_fee');
    expect(lateFees[0].amount).toBe('150.00');
    expect(lateFees[0].period_key).toBe('2026-07');
    expect(lateFees[0].due_date).toBe('2026-07-15');
    expect(lateFees[0].status).toBe('due');
    expect(lateFees[0].member_id).toBe(source.member_id);
    expect(lateFees[0].ownership_id).toBe(source.ownership_id);
    expect(lateFees[0].asset_id).toBe(source.asset_id);
    expect(lateFees[0].source_charge_id).toBe(source.charge_id);

    const originalRow = await db.queryOne<{ amount: string; status: string; due_date: string; period_key: string }>(
      sql`SELECT amount::text AS amount, status, due_date::text AS due_date, period_key FROM charges WHERE id = ${source.charge_id}`,
    );
    expect(originalRow).toEqual({ amount: '2500.00', status: 'due', due_date: '2026-06-05', period_key: '2026-06' });
  });
});

describe('STR-065 T-U2 — no late-fee config, no late fees', () => {
  it('raises nothing however overdue the basis is when late_fee_amount is left NULL', async () => {
    const db = await freshMigratedDb();
    await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-01', dueDate: '2026-01-05' });
    // No setLateFeeConfig call -- columns stay NULL.

    const lateFees = await runLateFeeSweep(db, '2026-07', '2026-07-15');

    expect(lateFees).toHaveLength(0);
    const rows = await db.query(sql`SELECT id FROM charges WHERE kind = 'late_fee'`);
    expect(rows).toHaveLength(0);
  });
});

describe('STR-065 T-U4 — a late_fee charge never itself accrues a late fee (no compounding)', () => {
  it('a second, much-later sweep does not raise a late fee on a previously-raised late_fee charge', async () => {
    const db = await freshMigratedDb();
    await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-01', dueDate: '2026-01-05' });
    await setLateFeeConfig(db, '150.00', 5); // due 2026-01-05 + 5 days grace = 2026-01-10

    const firstSweep = await runLateFeeSweep(db, '2026-02', '2026-02-01');
    expect(firstSweep).toHaveLength(1);

    // Far enough past the first late_fee charge's own due date that, were
    // it eligible, it would clear its grace period too -- it must not be.
    const secondSweep = await runLateFeeSweep(db, '2026-08', '2026-08-01');
    expect(secondSweep).toHaveLength(1); // the still-due maintenance source, one more period's worth
    expect(secondSweep[0].source_charge_id).not.toBe(firstSweep[0].charge_id);

    const compoundedRows = await db.query(
      sql`SELECT id FROM charges c WHERE c.kind = 'late_fee' AND c.source_charge_id IN (SELECT id FROM charges WHERE kind = 'late_fee')`,
    );
    expect(compoundedRows).toHaveLength(0);
  });
});

describe('STR-065 T-U3 — not-yet-overdue and already-settled charges attract no late fee', () => {
  it('a charge still within its grace period attracts no late fee', async () => {
    const db = await freshMigratedDb();
    await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-07', dueDate: '2026-07-10' });
    await setLateFeeConfig(db, '150.00', 5); // due 2026-07-10 + 5 days grace = 2026-07-15

    const lateFees = await runLateFeeSweep(db, '2026-07', '2026-07-12'); // still within grace

    expect(lateFees).toHaveLength(0);
  });

  it('a paid charge attracts no late fee even long overdue', async () => {
    const db = await freshMigratedDb();
    const paidSource = await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-01', dueDate: '2026-01-05' });
    await db.execute(sql`UPDATE charges SET status = 'paid' WHERE id = ${paidSource.charge_id}`);
    await setLateFeeConfig(db, '150.00', 5);

    const lateFees = await runLateFeeSweep(db, '2026-07', '2026-07-15');

    expect(lateFees).toHaveLength(0);
  });

  it('an in_payment charge attracts no late fee even long overdue', async () => {
    const db = await freshMigratedDb();
    const inPaymentSource = await seedSourceCharge(db, { maintenanceFee: '2500.00', periodKey: '2026-01', dueDate: '2026-01-05' });
    await db.execute(sql`UPDATE charges SET status = 'in_payment' WHERE id = ${inPaymentSource.charge_id}`);
    await setLateFeeConfig(db, '150.00', 5);

    const lateFees = await runLateFeeSweep(db, '2026-07', '2026-07-15');

    expect(lateFees).toHaveLength(0);
  });
});
