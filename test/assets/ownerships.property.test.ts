import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createOwnership, OwnershipConflictError } from '../../aws-blocks/assets/ownerships-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createMember } from '../../aws-blocks/members/members-api';
import { mulberry32 } from '../finance/prng';

// STR-053 — T-P1 (BE-P): for any generated sequence of asset creations and
// allotment attempts, every `allotted` asset has exactly one open ownership
// and `current_ownership_id` matches it; every `available` asset has none
// (AC1). No property-testing library is installed (no fast-check in
// package.json); reuses the mulberry32 seeded generator shared with
// test/finance/journal.property.test.ts.

const cleanupDbs: Database[] = [];

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-053 property: the registry and ownerships never disagree (AC1)', () => {
  it('every allotted asset has exactly one ownership matching current_ownership_id; every available asset has none', async () => {
    const db = new Database(new Scope(`str-053-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const project = await createProject(db, { name: 'Green Meadows' });
    const rand = mulberry32(20260721);

    const MEMBER_COUNT = 6;
    const ASSET_COUNT = 10;
    const ATTEMPT_COUNT = 60;

    const members = [];
    for (let i = 0; i < MEMBER_COUNT; i++) {
      members.push(await createMember(db, { name: `Member ${i}` }));
    }
    const assets = [];
    for (let i = 0; i < ASSET_COUNT; i++) {
      const type = rand() < 0.2 ? 'dividend' : 'flat';
      assets.push(await createAsset(db, { project_id: project.project_id, type, label: type === 'dividend' ? undefined : `A-${i}` }));
    }

    let successCount = 0;
    let conflictCount = 0;
    for (let i = 0; i < ATTEMPT_COUNT; i++) {
      const member = members[Math.floor(rand() * members.length)];
      const asset = assets[Math.floor(rand() * assets.length)];
      try {
        await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
        successCount++;
      } catch (e) {
        expect(e).toBeInstanceOf(OwnershipConflictError);
        conflictCount++;
      }
    }

    // Sanity: the generator actually exercised both branches.
    expect(successCount).toBeGreaterThan(0);
    expect(conflictCount).toBeGreaterThan(0);

    const assetRows = await db.query<{ id: string; status: string; current_ownership_id: string | null }>(
      sql`SELECT id, status, current_ownership_id FROM assets`,
    );
    for (const row of assetRows) {
      const ownershipsForAsset = await db.query<{ id: string }>(sql`SELECT id FROM ownerships WHERE asset_id = ${row.id}`);
      if (row.status === 'allotted') {
        expect(ownershipsForAsset).toHaveLength(1);
        expect(row.current_ownership_id).toBe(ownershipsForAsset[0].id);
      } else {
        expect(ownershipsForAsset).toHaveLength(0);
        expect(row.current_ownership_id).toBeNull();
      }
    }

    expect(successCount).toBe(assetRows.filter(r => r.status === 'allotted').length);
  });
});
