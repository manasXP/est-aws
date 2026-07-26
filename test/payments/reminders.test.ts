import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun } from '../../aws-blocks/payments/charges';
import { dispatchDueDateReminders } from '../../aws-blocks/payments/reminders';
import { FakePushAdapter } from '../../aws-blocks/notifications/push-adapter';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';

// STR-067 — due-date reminder dispatch after the charge run. Follows
// test/payments/charge-run.test.ts's exact conventions (fresh Database +
// Scope per test, MIGRATIONS_DIR, setMaintenanceFee direct-SQL helper).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-067-reminders-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

/** Tests set the singleton charge_settings row directly via SQL -- there is
 * no HTTP endpoint for this in this story (none is Red-tested). */
async function setMaintenanceFee(db: Database, fee: string): Promise<void> {
  await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${fee} WHERE id = 'default'`);
}

/** No `/me/devices` endpoint exists yet (ships with the mobile milestone,
 * E16/E17) -- tests seed a registered-devices row directly via SQL, mirroring
 * setMaintenanceFee's direct-SQL-in-test pattern. */
async function registerDevice(db: Database, memberId: string, platform: 'ios' | 'android', pushToken: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO registered_devices (id, member_id, platform, push_token) VALUES (${randomUUID()}, ${memberId}, ${platform}, ${pushToken})`,
  );
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-067 T-U1 — due-date reminders push to registered devices (TC-PAY-006)', () => {
  it('given due charges; when the run completes; then due-date reminder pushes go to the members\' registered devices', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
    await registerDevice(db, member.member_id, 'ios', 'ios-token-1');
    await registerDevice(db, member.member_id, 'android', 'android-token-1');

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    const adapter = new FakePushAdapter();
    await dispatchDueDateReminders(db, adapter, charges);

    expect(adapter.sent).toHaveLength(2);
    expect(new Set(adapter.sent.map(s => s.pushToken))).toEqual(new Set(['ios-token-1', 'android-token-1']));
  });

  it('a member with two due charges (two owned assets) still gets exactly one send per device, not one per charge', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const flatA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    const flatB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-102' });
    await createOwnership(db, member.member_id, { asset_id: flatA.asset_id });
    await createOwnership(db, member.member_id, { asset_id: flatB.asset_id });
    await registerDevice(db, member.member_id, 'ios', 'ios-token-1');
    await registerDevice(db, member.member_id, 'android', 'android-token-1');

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(charges).toHaveLength(2); // two charges, same member

    const adapter = new FakePushAdapter();
    await dispatchDueDateReminders(db, adapter, charges);

    expect(adapter.sent).toHaveLength(2); // deduped to one send per device, not per charge
    expect(new Set(adapter.sent.map(s => s.pushToken))).toEqual(new Set(['ios-token-1', 'android-token-1']));
  });
});

describe('STR-067 T-U2 — no due charges, or no registered devices, produces no send', () => {
  it('a member with no due charges (never admitted) but a registered device receives no reminder', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' }); // stays pending -- never admitted
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
    await registerDevice(db, member.member_id, 'ios', 'ios-token-1');

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(charges).toHaveLength(0);

    const adapter = new FakePushAdapter();
    await dispatchDueDateReminders(db, adapter, charges);

    expect(adapter.sent).toHaveLength(0);
  });

  it('a member with due charges but zero registered devices produces no send and does not throw', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(charges).toHaveLength(1);

    const adapter = new FakePushAdapter();
    await expect(dispatchDueDateReminders(db, adapter, charges)).resolves.not.toThrow();

    expect(adapter.sent).toHaveLength(0);
  });
});

describe('STR-067 T-U3 — dispatch reflects only the run\'s own returned charges, and a re-run adds nothing', () => {
  it('dispatch never references a charge the run did not itself raise', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, memberA.member_id);
    const assetA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, memberA.member_id, { asset_id: assetA.asset_id });
    await registerDevice(db, memberA.member_id, 'ios', 'ios-token-a');

    const memberB = await createMember(db, { name: 'Rohit Shah' }); // pending -- not accruing
    const assetB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-102' });
    await createOwnership(db, memberB.member_id, { asset_id: assetB.asset_id });
    await registerDevice(db, memberB.member_id, 'ios', 'ios-token-b');

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(charges.map(c => c.member_id)).toEqual([memberA.member_id]);

    const adapter = new FakePushAdapter();
    await dispatchDueDateReminders(db, adapter, charges);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].pushToken).toBe('ios-token-a');
  });

  it('re-running an already-completed period returns [] and dispatching it adds zero new sends', async () => {
    const db = await freshMigratedDb();
    await setMaintenanceFee(db, '2500.00');
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-101' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
    await registerDevice(db, member.member_id, 'ios', 'ios-token-1');

    const firstRun = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    const adapter = new FakePushAdapter();
    await dispatchDueDateReminders(db, adapter, firstRun);
    expect(adapter.sent).toHaveLength(1);

    const sentBefore = adapter.sent.length;
    const rerun = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(rerun).toHaveLength(0);

    await dispatchDueDateReminders(db, adapter, rerun);
    expect(adapter.sent).toHaveLength(sentBefore);
  });
});
