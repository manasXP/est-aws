import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun, getMaintenanceFee, chargeRunPeriodFromScheduledTime, ChargeSettingsNotConfiguredError } from '../../aws-blocks/payments/charges';
import { createMember, admitMember, suspendMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-061 — charge model and scheduled maintenance charge run, unit cases.
// Follows the STR-053 test pattern (test/assets/ownerships-api.test.ts):
// fresh Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-061-charges-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

/** Tests set the singleton charge_settings row directly via SQL -- there is
 * no HTTP endpoint for this in this story (none is Red-tested). */
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

describe('STR-061 T-U1 — two owned flats raise two maintenance charges (TC-PAY-001)', () => {
  it('the scheduled run raises exactly two charges for the period, each "2500.00" and due', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const flatA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    const flatB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-102' });
    await createOwnership(db, member.member_id, { asset_id: flatA.asset_id });
    await createOwnership(db, member.member_id, { asset_id: flatB.asset_id });

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    expect(charges).toHaveLength(2);
    for (const charge of charges) {
      expect(charge.amount).toBe('2500.00');
      expect(charge.status).toBe('due');
      expect(charge.member_id).toBe(member.member_id);
      expect(charge.kind).toBe('maintenance');
      expect(charge.period_key).toBe('2026-07');
      expect(charge.due_date).toBe('2026-07-05');
    }
    expect(new Set(charges.map(c => c.asset_id))).toEqual(new Set([flatA.asset_id, flatB.asset_id]));
  });
});

describe('STR-061 T-U2 — a pending member accrues no charges (TC-PAY-004)', () => {
  it('the scheduled run raises no charges for a pending member with seeded ownerships', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' }); // stays pending -- never admitted
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    expect(charges).toHaveLength(0);
    const rows = await db.query(sql`SELECT id FROM charges`);
    expect(rows).toHaveLength(0);
  });
});

describe('STR-061 T-U3 — a suspended member accrues normally (TC-PAY-005)', () => {
  it('raises the same charge for a suspended member as it would for an active one', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    await suspendMember(db, member.member_id, 'ec-actor');
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    expect(charges).toHaveLength(1);
    expect(charges[0].amount).toBe('2500.00');
    expect(charges[0].status).toBe('due');
    expect(charges[0].member_id).toBe(member.member_id);
    expect(charges[0].asset_id).toBe(asset.asset_id);
  });
});

describe('STR-061 T-U4 — amounts round-trip as exact decimal strings', () => {
  it('a fee configured as "1833.33" is stored and serialized as "1833.33"; no float appears anywhere in the charge path', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '1833.33');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    expect(await getMaintenanceFee(db)).toBe('1833.33');

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(charges).toHaveLength(1);
    expect(charges[0].amount).toBe('1833.33');

    const row = await db.queryOne<{ amount: string }>(
      sql`SELECT amount::text AS amount FROM charges WHERE id = ${charges[0].charge_id}`,
    );
    expect(row!.amount).toBe('1833.33');
  });
});

describe('STR-061 review fix — an unconfigured maintenance fee is rejected with a clear error', () => {
  it('runMaintenanceChargeRun throws ChargeSettingsNotConfiguredError when the fee is still the seeded "0.00" default', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    await expect(runMaintenanceChargeRun(db, '2026-07', '2026-07-05')).rejects.toThrow(ChargeSettingsNotConfiguredError);

    const rows = await db.query(sql`SELECT id FROM charges`);
    expect(rows).toHaveLength(0);
  });

  it('getMaintenanceFee itself throws ChargeSettingsNotConfiguredError when the fee is unconfigured', async () => {
    const db = await freshMigratedDb();
    await expect(getMaintenanceFee(db)).rejects.toThrow(ChargeSettingsNotConfiguredError);
  });
});

describe('STR-061 review fix — chargeRunPeriodFromScheduledTime IST period resolution', () => {
  it('resolves a plain mid-month UTC instant to its IST period key and due date', () => {
    expect(chargeRunPeriodFromScheduledTime('2026-07-15T04:00:00Z')).toEqual({
      periodKey: '2026-07',
      dueDate: '2026-07-15',
    });
  });

  it('resolves a UTC instant that crosses the IST year/month boundary', () => {
    expect(chargeRunPeriodFromScheduledTime('2025-12-31T21:30:00Z')).toEqual({
      periodKey: '2026-01',
      dueDate: '2026-01-01',
    });
  });
});

// Regression: the RDS Data API sends string parameters as untyped
// `stringValue` (no typeHint), and Postgres refuses to implicitly
// assign-cast text to a NUMERIC column -- a real-sandbox-only failure
// (`ChargeSettingsNotConfiguredError`'s sibling, "column amount is of type
// numeric but expression is of type text") that PGlite never surfaces
// locally, which is exactly why AC4's live-sandbox proof caught it and no
// local test previously did. Asserted at the query-text level since PGlite
// accepts the cast as a no-op either way.
describe('STR-061 regression — charges.amount is bound with an explicit ::numeric cast', () => {
  it('the charge INSERT casts the amount parameter, not just interpolates it as text', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const executeSpy = vi.spyOn(db, 'execute');
    await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    const insertCall = executeSpy.mock.calls.map(([query]) => query).find(query => query.sql.includes('INSERT INTO charges'));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toMatch(/\$\d+::numeric/);
  });
});
