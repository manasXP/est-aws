import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { runMaintenanceChargeRun } from '../../aws-blocks/payments/charges';
import { createMember, admitMember, suspendMember, ceaseMember, type MemberStatus } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { formatMoney, parseMoney, sumMoney } from '../../aws-blocks/money';
import { mulberry32 } from '../finance/prng';

// STR-063 — T-P1 (BE-P): for any basis and any N >= 1, running the period N
// times produces a charge set identical to running it once. Same
// basis-generation shape as test/payments/charge-run.property.test.ts
// (STR-061), copy-adapted per this story's brief rather than sharing a
// helper for a single reuse.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

const MAINTENANCE_FEE = '1833.33';

describe('STR-063 property: running a period N times matches running it once', () => {
  it('re-running the same period any number of times leaves the charge set unchanged', async () => {
    const db = new Database(new Scope(`str-063-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);
    await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${MAINTENANCE_FEE} WHERE id = 'default'`);

    const project = await createProject(db, { name: 'Green Meadows' });
    const rand = mulberry32(20260726);

    const MEMBER_COUNT = 8;
    const ASSET_COUNT = 12;

    const members: { member_id: string; member_status: MemberStatus }[] = [];
    for (let i = 0; i < MEMBER_COUNT; i++) {
      const member = await createMember(db, { name: `Member ${i}` });
      const roll = rand();
      let status: MemberStatus = 'pending';
      if (roll < 0.25) {
        status = 'pending';
      } else if (roll < 0.5) {
        await admitMember(db, member.member_id);
        status = 'active';
      } else if (roll < 0.75) {
        await admitMember(db, member.member_id);
        await suspendMember(db, member.member_id, 'ec-actor');
        status = 'suspended';
      } else {
        await admitMember(db, member.member_id);
        await ceaseMember(db, member.member_id, 'resigned');
        status = 'ceased';
      }
      members.push({ member_id: member.member_id, member_status: status });
    }

    const accruing = new Set(members.filter(m => m.member_status === 'active' || m.member_status === 'suspended').map(m => m.member_id));

    const expectedAssetIds = new Set<string>();
    for (let i = 0; i < ASSET_COUNT; i++) {
      const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${i}` });
      const owner = members[Math.floor(rand() * members.length)];
      await createOwnership(db, owner.member_id, { asset_id: asset.asset_id });
      if (accruing.has(owner.member_id)) {
        expectedAssetIds.add(asset.asset_id);
      }
    }

    const firstRun = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
    expect(firstRun).toHaveLength(expectedAssetIds.size);

    const firstRunRows = await db.query<{ ownership_id: string; amount: string }>(
      sql`SELECT ownership_id, amount::text AS amount FROM charges ORDER BY ownership_id`,
    );
    const firstRunTotal = sumMoney(firstRunRows.map(row => row.amount));
    expect(firstRunTotal).toBe(formatMoney(parseMoney(MAINTENANCE_FEE) * BigInt(expectedAssetIds.size)));

    const n = 1 + Math.floor(rand() * 4); // 1..4 extra re-runs
    for (let i = 0; i < n; i++) {
      const rerun = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');
      expect(rerun).toHaveLength(0);
    }

    const finalRows = await db.query<{ ownership_id: string; amount: string }>(
      sql`SELECT ownership_id, amount::text AS amount FROM charges ORDER BY ownership_id`,
    );
    expect(finalRows).toEqual(firstRunRows);
    expect(sumMoney(finalRows.map(row => row.amount))).toBe(firstRunTotal);
  });
});
