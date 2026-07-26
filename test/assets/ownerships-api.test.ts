import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql, DatabaseErrors, isBlocksError } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import {
  createOwnership,
  getOwnership,
  listOwnershipsForMember,
  updateOwnership,
  listBillableOwnerships,
  OwnershipValidationError,
  OwnershipConflictError,
} from '../../aws-blocks/assets/ownerships-api';
import { createAsset, updateAsset, AssetValidationError } from '../../aws-blocks/assets/assets-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createMember } from '../../aws-blocks/members/members-api';

// STR-053 — Ownership allotment via asset_id, unit cases. Follows the
// STR-051 test pattern (test/assets/assets-api.test.ts): fresh Database +
// Scope per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-053-ownerships-test-${randomUUID()}`), 'db');
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

describe('STR-053 T-U1 — creating an ownership allots the referenced asset (TC-AST-003)', () => {
  it('transitions the asset to allotted and points current_ownership_id at the new record, in one transaction', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    expect(ownership.ownership_id).toEqual(expect.any(String));
    expect(ownership.member_id).toBe(member.member_id);
    expect(ownership.asset_id).toBe(asset.asset_id);
    expect(ownership.project_id).toBe(project.project_id);

    const row = await db.queryOne<{ status: string; current_ownership_id: string | null }>(
      sql`SELECT status, current_ownership_id FROM assets WHERE id = ${asset.asset_id}`,
    );
    expect(row!.status).toBe('allotted');
    expect(row!.current_ownership_id).toBe(ownership.ownership_id);

    const fetched = await getOwnership(db, ownership.ownership_id);
    expect(fetched).toEqual(ownership);
  });
});

describe('STR-053 T-U2 — a second assignment against an allotted asset is rejected (TC-AST-004)', () => {
  it('throws OwnershipConflictError and writes no second ownership row', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    await expect(createOwnership(db, memberB.member_id, { asset_id: asset.asset_id })).rejects.toThrow(OwnershipConflictError);

    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(1);
    expect(await listOwnershipsForMember(db, memberB.member_id)).toHaveLength(0);
  });

  // AC2: "Double allotment is impossible (409), including under concurrent
  // attempts" -- the guarded UPDATE (WHERE status = 'available') is a single
  // atomic SQL statement, so two genuinely concurrent createOwnership calls
  // for the same asset are serialized by ordinary row-level locking: exactly
  // one succeeds.
  it('under concurrent attempts against the same asset, exactly one createOwnership succeeds', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    const results = await Promise.allSettled([
      createOwnership(db, memberA.member_id, { asset_id: asset.asset_id }),
      createOwnership(db, memberB.member_id, { asset_id: asset.asset_id }),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);

    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(1);
  });

  // Belt-and-suspenders (same pattern as migrations/003_reversal_uniqueness.sql):
  // the ownerships.asset_id UNIQUE constraint rejects a second row for the
  // same asset even bypassing createOwnership's own guard entirely.
  it('the ownerships.asset_id UNIQUE constraint rejects a second row for the same asset via direct SQL', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    await expect(
      db.execute(sql`INSERT INTO ownerships (id, member_id, asset_id) VALUES (${randomUUID()}, ${memberB.member_id}, ${asset.asset_id})`),
    ).rejects.toSatisfy((e: unknown) => isBlocksError(e, DatabaseErrors.UniqueConstraintViolation));
  });
});

describe('STR-053 T-U3 — a direct edit of current_ownership fails (TC-AST-023)', () => {
  it('rejects PATCH /ownerships/{id} carrying asset_id or member_id, writing nothing', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const assetA = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const assetB = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-205' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: assetA.asset_id });

    await expect(updateOwnership(db, ownership.ownership_id, { asset_id: assetB.asset_id })).rejects.toThrow(OwnershipValidationError);
    await expect(
      updateOwnership(db, ownership.ownership_id, { member_id: memberB.member_id } as never),
    ).rejects.toThrow(OwnershipValidationError);

    const unchanged = await getOwnership(db, ownership.ownership_id);
    expect(unchanged!.asset_id).toBe(assetA.asset_id);
    expect(unchanged!.member_id).toBe(memberA.member_id);
  });

  // Complementary at the Asset-write layer: current_ownership_id is not part
  // of AssetInput at all, so updateAsset silently ignores it -- confirmed
  // here rather than left implicit.
  it('does not allow current_ownership_id to be set via updateAsset', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    await updateAsset(db, asset.asset_id, { current_ownership_id: 'bogus-ownership-id' } as never);

    const row = await db.queryOne<{ current_ownership_id: string | null }>(
      sql`SELECT current_ownership_id FROM assets WHERE id = ${asset.asset_id}`,
    );
    expect(row!.current_ownership_id).toBeNull();
  });
});

describe('STR-053 T-U4 — a dividend holding appears in the billable-asset basis like any owned asset (TC-AST-005)', () => {
  it('includes a dividend ownership in listBillableOwnerships identically to a flat ownership', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const flat = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const dividend = await createAsset(db, { project_id: project.project_id, type: 'dividend' });

    const flatOwnership = await createOwnership(db, memberA.member_id, { asset_id: flat.asset_id });
    const dividendOwnership = await createOwnership(db, memberB.member_id, { asset_id: dividend.asset_id });

    const billable = await listBillableOwnerships(db);
    const flatEntry = billable.find(b => b.ownership_id === flatOwnership.ownership_id);
    const dividendEntry = billable.find(b => b.ownership_id === dividendOwnership.ownership_id);

    expect(flatEntry).toBeDefined();
    expect(dividendEntry).toBeDefined();
    expect(dividendEntry!.asset_type).toBe('dividend');
    // No separate payout shape or field set for a dividend holding -- it
    // appears in the basis with exactly the same shape as any other type.
    expect(Object.keys(dividendEntry!).sort()).toEqual(Object.keys(flatEntry!).sort());
  });
});

// Genuine Red gap, same rationale as STR-051's own T-U4 in assets-api.test.ts:
// the story's own "A real gap in existing code" note requires this fix for
// AC1 to actually hold once `allotted` is reachable, but no T-U/T-C case in
// the story text names it -- covered here rather than left silently
// unverified.
describe('STR-053 code review — updateAsset rejects a status change on an allotted asset', () => {
  it('throws AssetValidationError, leaving the asset allotted and the ownership intact', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    await expect(updateAsset(db, asset.asset_id, { status: 'available' })).rejects.toThrow(AssetValidationError);

    const row = await db.queryOne<{ status: string; current_ownership_id: string | null }>(
      sql`SELECT status, current_ownership_id FROM assets WHERE id = ${asset.asset_id}`,
    );
    expect(row!.status).toBe('allotted');
    expect(row!.current_ownership_id).toBe(ownership.ownership_id);
  });

  it('still allows label/attributes edits on an allotted asset (status unchanged)', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const updated = await updateAsset(db, asset.asset_id, { label: 'A-205' });
    expect(updated!.label).toBe('A-205');
    expect(updated!.status).toBe('allotted');
  });
});

describe('STR-053 — creating an ownership against a nonexistent asset is rejected', () => {
  it('throws OwnershipValidationError and writes nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });

    await expect(createOwnership(db, member.member_id, { asset_id: 'no-such-asset' })).rejects.toThrow(OwnershipValidationError);
    expect(await listOwnershipsForMember(db, member.member_id)).toHaveLength(0);
  });
});

describe('STR-053 — creating an ownership against a nonexistent member is rejected', () => {
  it('throws OwnershipValidationError and writes nothing, leaving the asset available', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    await expect(createOwnership(db, 'no-such-member', { asset_id: asset.asset_id })).rejects.toThrow(OwnershipValidationError);

    const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM assets WHERE id = ${asset.asset_id}`);
    expect(row!.status).toBe('available');
  });
});

describe('STR-053 — updateOwnership amends co_owner_names only', () => {
  it('updates co_owner_names and returns null for a nonexistent ownership', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    const updated = await updateOwnership(db, ownership.ownership_id, { co_owner_names: ['Priya Rao'] });
    expect(updated!.co_owner_names).toEqual(['Priya Rao']);

    expect(await updateOwnership(db, 'does-not-exist', { co_owner_names: ['X'] })).toBeNull();
  });
});
