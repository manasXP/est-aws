import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun } from '../../aws-blocks/payments/charges';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-063 — idempotent period-keyed charge re-runs. Same freshMigratedDb()/
// setMaintenanceFee() pattern as test/payments/charge-run.test.ts (STR-061).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-063-charges-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

async function setMaintenanceFee(db: Database, fee: string): Promise<void> {
  await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${fee} WHERE id = 'default'`);
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-063 T-U1 — re-running a completed period raises no new charges (covers TC-PAY-002)', () => {
  it('a retry/duplicate trigger for the same period leaves amounts and count unchanged', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const flatA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    const flatB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-102' });
    await createOwnership(db, member.member_id, { asset_id: flatA.asset_id });
    await createOwnership(db, member.member_id, { asset_id: flatB.asset_id });

    const first = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(first).toHaveLength(2);
    for (const charge of first) expect(charge.amount).toBe('2500.00');

    const second = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(second).toHaveLength(0);

    const rows = await db.query<{ amount: string }>(sql`SELECT amount::text AS amount FROM charges`);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.amount).toBe('2500.00');
  });
});

describe('STR-063 T-U2 — a re-run after a partial failure completes without duplicating raised charges', () => {
  it('resumes to completeness, raising only the still-missing charge and leaving the pre-seeded one untouched', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberA.member_id);
    await admitMember(db, memberB.member_id);
    const flatA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    const flatB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-102' });
    const ownershipA = await createOwnership(db, memberA.member_id, { asset_id: flatA.asset_id });
    await createOwnership(db, memberB.member_id, { asset_id: flatB.asset_id });

    // Simulate a mid-run failure: ownershipA's charge was already inserted by
    // a previous, partially-failed run; ownershipB's was never raised.
    const preSeededChargeId = randomUUID();
    await db.execute(
      sql`INSERT INTO charges (id, member_id, ownership_id, kind, period_key, amount, due_date, status)
          VALUES (${preSeededChargeId}, ${memberA.member_id}, ${ownershipA.ownership_id}, 'maintenance', '2026-07', '2500.00', '2026-07-05', 'due')`,
    );

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    expect(charges).toHaveLength(1);
    expect(charges[0].member_id).toBe(memberB.member_id);
    expect(charges[0].amount).toBe('2500.00');

    const rows = await db.query<{ id: string; amount: string }>(sql`SELECT id, amount::text AS amount FROM charges`);
    expect(rows).toHaveLength(2);
    const preSeededRow = rows.find(row => row.id === preSeededChargeId);
    expect(preSeededRow).toBeDefined();
    expect(preSeededRow!.amount).toBe('2500.00');
  });
});
