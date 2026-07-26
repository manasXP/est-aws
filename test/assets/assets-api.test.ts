import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createAsset, listAssets, updateAsset, getAssetDetail, AssetValidationError } from '../../aws-blocks/assets/assets-api';
import { createOwnership, transferOwnership } from '../../aws-blocks/assets/ownerships-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';

// STR-051 — Asset registry business logic, unit cases. Follows the STR-031
// test pattern (test/projects/projects-api.test.ts): fresh Database + Scope
// per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-051-assets-test-${randomUUID()}`), 'db');
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

describe('STR-051 T-U1 — creating an asset', () => {
  it('binds to exactly one project, has a type in the enum, and starts available', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });

    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    expect(asset.asset_id).toEqual(expect.any(String));
    expect(asset.project_id).toBe(project.project_id);
    expect(asset.type).toBe('flat');
    expect(asset.status).toBe('available');

    const list = await listAssets(db);
    expect(list.some(a => a.asset_id === asset.asset_id)).toBe(true);
  });
});

describe('STR-051 T-U2 — a type outside the enum is rejected', () => {
  it('rejects a fifth type and writes nothing', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });

    await expect(createAsset(db, { project_id: project.project_id, type: 'penthouse' })).rejects.toThrow(AssetValidationError);
    expect(await listAssets(db)).toHaveLength(0);
  });
});

describe('STR-051 T-U3 — dividend vs. physical asset attributes', () => {
  it('persists a dividend asset with no label', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });

    const asset = await createAsset(db, { project_id: project.project_id, type: 'dividend' });

    expect(asset.label).toBeUndefined();
  });

  it('round-trips label and attributes unchanged for a physical asset', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });

    const asset = await createAsset(db, {
      project_id: project.project_id,
      type: 'flat',
      label: 'A-204',
      attributes: { area_sqft: 950, floor: 2 },
    });

    expect(asset.label).toBe('A-204');
    expect(asset.attributes).toEqual({ area_sqft: 950, floor: 2 });
  });

  // code-reviewer finding: an explicit empty-string label bypassed the
  // truthy check on both create and update.
  it('treats an explicit empty-string label as no label, on both create and update', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });

    const created = await createAsset(db, { project_id: project.project_id, type: 'dividend', label: '' });
    expect(created.label).toBeUndefined();

    const updated = await updateAsset(db, created.asset_id, { label: '' });
    expect(updated!.label).toBeUndefined();
  });
});

describe('STR-051 code review — GET /v1/assets filters by project_id, type, and status', () => {
  it('narrows the list to matching assets only', async () => {
    const db = await freshMigratedDb();
    const projectA = await createProject(db, { name: 'Project A' });
    const projectB = await createProject(db, { name: 'Project B' });

    const flatInA = await createAsset(db, { project_id: projectA.project_id, type: 'flat', label: 'A-1' });
    const villaInA = await createAsset(db, { project_id: projectA.project_id, type: 'villa', label: 'A-2' });
    await createAsset(db, { project_id: projectB.project_id, type: 'flat', label: 'B-1' });

    const byProject = await listAssets(db, { projectId: projectA.project_id });
    expect(byProject.map(a => a.asset_id).sort()).toEqual([flatInA.asset_id, villaInA.asset_id].sort());

    const byType = await listAssets(db, { type: 'flat' });
    expect(byType).toHaveLength(2);

    const byStatus = await listAssets(db, { status: 'society_retained' });
    expect(byStatus).toHaveLength(0);

    const byProjectAndType = await listAssets(db, { projectId: projectA.project_id, type: 'flat' });
    expect(byProjectAndType).toEqual([flatInA]);
  });
});

// Genuine Red gap: the story's Green step names "edit" (PATCH) as part of
// the admin surface, but no T-U/T-C case in the story text covers it —
// covered here rather than left silently unverified.
describe('STR-051 T-U4 — editing an asset', () => {
  it('updates label/attributes/status and rejects changing the immutable project_id/type', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    const updated = await updateAsset(db, asset.asset_id, { label: 'A-205', status: 'society_retained' });
    expect(updated!.label).toBe('A-205');
    expect(updated!.status).toBe('society_retained');

    await expect(updateAsset(db, asset.asset_id, { project_id: 'some-other-project' })).rejects.toThrow(AssetValidationError);
    await expect(updateAsset(db, asset.asset_id, { type: 'villa' })).rejects.toThrow(AssetValidationError);
  });

  it('returns null for a nonexistent asset', async () => {
    const db = await freshMigratedDb();
    expect(await updateAsset(db, 'does-not-exist', { label: 'X' })).toBeNull();
  });
});

describe('STR-051 — creating an asset against a nonexistent project is rejected', () => {
  it('throws AssetValidationError and writes nothing', async () => {
    const db = await freshMigratedDb();
    await expect(createAsset(db, { project_id: 'no-such-project', type: 'flat' })).rejects.toThrow(AssetValidationError);
    expect(await listAssets(db)).toHaveLength(0);
  });
});

describe('STR-055 T-U3 — asset detail returns the full owner history across transfers (covers TC-AST-022)', () => {
  it('lists every ownership newest first, with to: null only for the currently-open one', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const memberA = await createMember(db, { name: 'Asha Rao' });
    const memberB = await createMember(db, { name: 'Bala Iyer' });
    await admitMember(db, memberB.member_id);
    const memberC = await createMember(db, { name: 'Chetan Nair' });
    await admitMember(db, memberC.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: 'A-204' });

    const ownership1 = await createOwnership(db, memberA.member_id, { asset_id: asset.asset_id });
    const ownership2 = await transferOwnership(db, ownership1.ownership_id, { to_member_id: memberB.member_id });
    const ownership3 = await transferOwnership(db, ownership2!.ownership_id, { to_member_id: memberC.member_id });

    const detail = await getAssetDetail(db, asset.asset_id);

    expect(detail).not.toBeNull();
    expect(detail!.asset_id).toBe(asset.asset_id);
    expect(detail!.owner_history).toHaveLength(3);

    const [entry3, entry2, entry1] = detail!.owner_history;
    expect(entry3.ownership_id).toBe(ownership3!.ownership_id);
    expect(entry3.member_id).toBe(memberC.member_id);
    expect(entry3.member_name).toBe('Chetan Nair');
    expect(entry3.to).toBeNull();

    expect(entry2.ownership_id).toBe(ownership2!.ownership_id);
    expect(entry2.member_id).toBe(memberB.member_id);
    expect(entry2.member_name).toBe('Bala Iyer');
    expect(entry2.to).not.toBeNull();

    expect(entry1.ownership_id).toBe(ownership1.ownership_id);
    expect(entry1.member_id).toBe(memberA.member_id);
    expect(entry1.member_name).toBe('Asha Rao');
    expect(entry1.to).not.toBeNull();
    expect(typeof entry1.from).toBe('string');
  });

  it('returns null for a nonexistent asset', async () => {
    const db = await freshMigratedDb();
    expect(await getAssetDetail(db, 'does-not-exist')).toBeNull();
  });
});
