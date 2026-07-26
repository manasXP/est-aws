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

// STR-061 — T-P1 (BE-P): for any generated set of members (mixed statuses),
// assets, and ownerships: charge count equals the number of assets owned by
// accruing (active/suspended) members, and the total of amounts equals the
// exact-decimal sum. No property-testing library is installed (no
// fast-check in package.json); follows the exact pattern of
// test/finance/journal.property.test.ts, reusing the shared seeded PRNG
// helpers in test/finance/prng.ts.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

const MAINTENANCE_FEE = '1833.33';

describe('STR-061 property: charge count and total match the accruing basis', () => {
  it('charge count equals the assets owned by active/suspended members; the amount total is the exact-decimal sum', async () => {
    const db = new Database(new Scope(`str-061-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);
    await db.execute(sql`UPDATE charge_settings SET maintenance_fee = ${MAINTENANCE_FEE} WHERE id = 'default'`);

    const project = await createProject(db, { name: 'Green Meadows' });
    const rand = mulberry32(20260726);

    const MEMBER_COUNT = 8;
    const ASSET_COUNT = 12;

    // Mixed statuses -- pending stays as created; active/suspended/ceased
    // each drive their own lifecycle transition. ceaseMember's default
    // ownership-lookup stub always reports no ownerships held, so cessation
    // is never blocked here regardless of what's assigned below.
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

    const charges = await runMaintenanceChargeRun(db, '2026-07', '2026-07-05');

    // Sanity: the generator actually produced both accruing and non-accruing assets.
    expect(expectedAssetIds.size).toBeGreaterThan(0);
    expect(expectedAssetIds.size).toBeLessThan(ASSET_COUNT);

    expect(charges).toHaveLength(expectedAssetIds.size);
    expect(new Set(charges.map(c => c.asset_id))).toEqual(expectedAssetIds);
    for (const charge of charges) {
      expect(charge.amount).toBe(MAINTENANCE_FEE);
    }

    const expectedTotal = formatMoney(parseMoney(MAINTENANCE_FEE) * BigInt(expectedAssetIds.size));
    expect(sumMoney(charges.map(c => c.amount))).toBe(expectedTotal);
  });
});
