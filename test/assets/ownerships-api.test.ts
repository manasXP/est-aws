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
  transferOwnership,
  OwnershipValidationError,
  OwnershipConflictError,
} from '../../aws-blocks/assets/ownerships-api';
import { createAsset, updateAsset, AssetConflictError } from '../../aws-blocks/assets/assets-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';

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
  // one succeeds. Following test/finance/reversal.test.ts's precedent
  // (~line 216-224) for its own double-write race: PGliteEngine is
  // single-connection and its own docstring warns concurrent
  // beginTransaction() calls interleave rather than serialize, so a real
  // Promise.allSettled-style concurrent test against it is unreliable in
  // this repo (it can produce a raw TransactionFailedException instead of
  // the app's OwnershipConflictError) and would prove nothing about the
  // guarded-UPDATE logic itself. Calling createOwnership twice sequentially
  // instead proves that logic directly (AC2's actual guarantee); production
  // runs on DataApiEngine, not PGliteEngine.
  it('a second sequential createOwnership against the same asset rejects with OwnershipConflictError', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });
    await expect(createOwnership(db, memberB.member_id, { asset_id: asset.asset_id })).rejects.toThrow(OwnershipConflictError);

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
  it('throws AssetConflictError, leaving the asset allotted and the ownership intact', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const member = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });

    await expect(updateAsset(db, asset.asset_id, { status: 'available' })).rejects.toThrow(AssetConflictError);

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

// STR-055 — Ownership transfer (close-and-create) and its settlement gate.
// Follows STR-053's own test pattern above: fresh Database + Scope per test.

interface RawOwnershipRow {
  id: string;
  member_id: string;
  asset_id: string;
  co_owner_names: string | null;
  created_at: string | Date;
  closed_at: string | Date | null;
}

async function rawOwnershipRow(db: Database, ownershipId: string): Promise<RawOwnershipRow | null> {
  return db.queryOne<RawOwnershipRow>(
    sql`SELECT id, member_id, asset_id, co_owner_names, created_at, closed_at FROM ownerships WHERE id = ${ownershipId}`,
  );
}

async function seedCharge(
  db: Database,
  memberId: string,
  ownershipId: string,
  status: 'due' | 'in_payment' | 'paid',
): Promise<void> {
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${randomUUID()}, ${memberId}, ${ownershipId}, '1250.00', '2026-08-01', ${status})`,
  );
}

describe('STR-055 T-U1 — transfer of an ownership with outstanding charges is rejected (covers TC-AST-020)', () => {
  it('throws OwnershipConflictError, leaving the ownership open and the asset unchanged', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });
    await seedCharge(db, memberA.member_id, ownership.ownership_id, 'due');

    await expect(transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id })).rejects.toThrow(
      OwnershipConflictError,
    );

    const row = await rawOwnershipRow(db, ownership.ownership_id);
    expect(row!.closed_at).toBeNull();

    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(1);

    const assetRow = await db.queryOne<{ current_ownership_id: string | null }>(
      sql`SELECT current_ownership_id FROM assets WHERE id = ${asset.asset_id}`,
    );
    expect(assetRow!.current_ownership_id).toBe(ownership.ownership_id);
  });
});

describe('STR-055 T-U2 — transfer of a settled ownership closes and creates (covers TC-AST-021)', () => {
  it('closes the old record unchanged, creates a new one for the new member, and re-points current_ownership', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberB.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id, co_owner_names: ['Priya Rao'] });
    await seedCharge(db, memberA.member_id, ownership.ownership_id, 'paid');

    const before = await rawOwnershipRow(db, ownership.ownership_id);

    const transferred = await transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id });

    expect(transferred).not.toBeNull();
    expect(transferred!.ownership_id).not.toBe(ownership.ownership_id);
    expect(transferred!.member_id).toBe(memberB.member_id);
    expect(transferred!.asset_id).toBe(asset.asset_id);
    expect(transferred!.co_owner_names).toBeUndefined();

    const closed = await rawOwnershipRow(db, ownership.ownership_id);
    expect(closed!.closed_at).not.toBeNull();
    expect(closed!.member_id).toBe(before!.member_id);
    expect(closed!.asset_id).toBe(before!.asset_id);
    expect(closed!.co_owner_names).toBe(before!.co_owner_names);
    expect(closed!.created_at).toEqual(before!.created_at);

    const assetRow = await db.queryOne<{ status: string; current_ownership_id: string | null }>(
      sql`SELECT status, current_ownership_id FROM assets WHERE id = ${asset.asset_id}`,
    );
    expect(assetRow!.status).toBe('allotted');
    expect(assetRow!.current_ownership_id).toBe(transferred!.ownership_id);
  });
});

describe('STR-055 code review — updateOwnership rejects an edit of a closed ownership (AC2)', () => {
  it('throws OwnershipValidationError and writes nothing', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberB.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });
    await transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id });

    await expect(updateOwnership(db, ownership.ownership_id, { co_owner_names: ['X'] })).rejects.toThrow(
      OwnershipValidationError,
    );

    const row = await rawOwnershipRow(db, ownership.ownership_id);
    expect(row!.co_owner_names).toBeNull();
  });
});

describe('STR-055 code review — listBillableOwnerships reflects transfer re-pointing (AC4)', () => {
  it('includes the new ownership for the asset and excludes the old, now-closed one', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberB.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    const transferred = await transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id });

    const billable = await listBillableOwnerships(db);
    const forAsset = billable.filter(b => b.asset_id === asset.asset_id);
    expect(forAsset).toHaveLength(1);
    expect(forAsset[0].ownership_id).toBe(transferred!.ownership_id);
  });
});

describe('STR-055 — transfer against a nonexistent ownership id', () => {
  it('returns null', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Bala Iyer' });

    expect(await transferOwnership(db, 'does-not-exist', { to_member_id: member.member_id })).toBeNull();
  });
});

describe('STR-055 — transfer to a nonexistent member is rejected', () => {
  it('throws OwnershipValidationError, writes nothing, and leaves the ownership open', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    await expect(transferOwnership(db, ownership.ownership_id, { to_member_id: 'no-such-member' })).rejects.toThrow(
      OwnershipValidationError,
    );

    const row = await rawOwnershipRow(db, ownership.ownership_id);
    expect(row!.closed_at).toBeNull();
    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(1);
  });
});

// Genuine gap, same posture as STR-053's own "code review" describe blocks:
// the Admin OpenAPI's POST .../transfer explicitly declares "422 if the
// receiving member is not active", and every member starts `pending`
// (members-api.ts's createMember) -- an un-admitted to_member_id must be
// rejected exactly like a nonexistent one, not silently accepted.
describe('STR-055 — transfer to a non-active member is rejected', () => {
  it('throws OwnershipValidationError, writes nothing, and leaves the ownership open', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' }); // left pending -- not admitted
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    await expect(transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id })).rejects.toThrow(
      OwnershipValidationError,
    );

    const row = await rawOwnershipRow(db, ownership.ownership_id);
    expect(row!.closed_at).toBeNull();
    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(1);
  });
});

// Same sequential-not-concurrent precedent as STR-053's own "a second
// sequential createOwnership" test above (PGliteEngine is single-connection
// and doesn't serialize genuinely concurrent beginTransaction() calls --
// see test/finance/reversal.test.ts's own precedent -- so this proves the
// guarded-close logic directly rather than attempting an unreliable
// Promise.allSettled race against this engine; production runs on
// DataApiEngine, not PGliteEngine).
describe('STR-055 — transferring an already-closed ownership a second time is rejected', () => {
  it('the second sequential call throws OwnershipConflictError', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberB.member_id);
    const memberC = await createMember(db, { name: 'Chetan Nair' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });
    const ownership = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });

    await transferOwnership(db, ownership.ownership_id, { to_member_id: memberB.member_id });
    // memberC is deliberately left `pending` -- the already-closed check
    // (existingRow.closed_at !== null) fires before the active-member check,
    // so this still proves OwnershipConflictError, not the unrelated 422.
    await expect(transferOwnership(db, ownership.ownership_id, { to_member_id: memberC.member_id })).rejects.toThrow(
      OwnershipConflictError,
    );

    const ownershipsForAsset = await db.query(sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id}`);
    expect(ownershipsForAsset).toHaveLength(2);
  });
});
