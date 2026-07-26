import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createOwnership, transferOwnership, OwnershipConflictError } from '../../aws-blocks/assets/ownerships-api';
import { createAsset, getAssetDetail } from '../../aws-blocks/assets/assets-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
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

interface RawOwnershipRow {
  id: string;
  member_id: string;
  asset_id: string;
  co_owner_names: string | null;
  created_at: string | Date;
  closed_at: string | Date | null;
}

function normalize(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function rawOwnershipRow(db: Database, ownershipId: string): Promise<RawOwnershipRow> {
  const row = await db.queryOne<RawOwnershipRow>(
    sql`SELECT id, member_id, asset_id, co_owner_names, created_at, closed_at FROM ownerships WHERE id = ${ownershipId}`,
  );
  return row!;
}

// STR-055 — T-P1 (BE-P): for an arbitrary generated sequence of transfers
// across several assets (no charges seeded at all, so every transfer is
// trivially settled -- T-U1 above already covers the settlement gate
// itself), after every transfer: exactly one open ownership per asset,
// every previously-closed row's fields unchanged from the moment it was
// first observed closed (snapshot-and-compare), and getAssetDetail's
// owner_history reproduces the real chronological transfer order, reversed.
describe('STR-055 property: close-and-create transfers preserve owner history (AC1-AC3)', () => {
  it('keeps exactly one open ownership per asset, never mutates a closed row, and owner_history matches the real order', async () => {
    const db = new Database(new Scope(`str-055-prop-test-${randomUUID()}`), 'db');
    cleanupDbs.push(db);
    await runLocalMigrations(db, MIGRATIONS_DIR);

    const project = await createProject(db, { name: 'Green Meadows' });
    const rand = mulberry32(20260726);

    const MEMBER_COUNT = 5;
    const ASSET_COUNT = 4;
    const TRANSFER_COUNT = 30;

    // Transfer targets must be active (Admin OpenAPI: "422 if the receiving
    // member is not active") -- admitted right after creation so every
    // random pick below is a legal transfer target.
    const members = [];
    for (let i = 0; i < MEMBER_COUNT; i++) {
      const member = await createMember(db, { name: `Member ${i}` });
      await admitMember(db, member.member_id);
      members.push(member);
    }
    const assets = [];
    for (let i = 0; i < ASSET_COUNT; i++) {
      assets.push(await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${i}` }));
    }

    // Chronological (member_id, ownership_id) sequence per asset -- the
    // ground truth getAssetDetail's owner_history is checked against.
    const history: Record<string, { ownershipId: string; memberId: string }[]> = {};
    // Snapshot of a closed row's fields, captured the moment it was first
    // observed closed -- re-checked identical after every later transfer.
    const closedSnapshots: Record<string, RawOwnershipRow> = {};

    for (const asset of assets) {
      const member = members[Math.floor(rand() * members.length)];
      const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
      history[asset.asset_id] = [{ ownershipId: ownership.ownership_id, memberId: member.member_id }];
    }

    for (let i = 0; i < TRANSFER_COUNT; i++) {
      const asset = assets[Math.floor(rand() * assets.length)];
      const assetHistory = history[asset.asset_id];
      const openOwnershipId = assetHistory[assetHistory.length - 1].ownershipId;
      const toMember = members[Math.floor(rand() * members.length)];

      const newOwnership = await transferOwnership(db, openOwnershipId, { to_member_id: toMember.member_id });
      expect(newOwnership).not.toBeNull();
      assetHistory.push({ ownershipId: newOwnership!.ownership_id, memberId: toMember.member_id });

      const closedRow = await rawOwnershipRow(db, openOwnershipId);
      expect(closedRow.closed_at).not.toBeNull();
      closedSnapshots[openOwnershipId] = closedRow;

      // (a) exactly one open ownership row for this asset.
      const openRows = await db.query<{ id: string }>(
        sql`SELECT id FROM ownerships WHERE asset_id = ${asset.asset_id} AND closed_at IS NULL`,
      );
      expect(openRows).toHaveLength(1);
      expect(openRows[0].id).toBe(newOwnership!.ownership_id);

      // (b) every previously-closed row is unchanged from its snapshot.
      for (const [ownershipId, snapshot] of Object.entries(closedSnapshots)) {
        const row = await rawOwnershipRow(db, ownershipId);
        expect(row.member_id).toBe(snapshot.member_id);
        expect(row.asset_id).toBe(snapshot.asset_id);
        expect(row.co_owner_names).toBe(snapshot.co_owner_names);
        expect(normalize(row.created_at)).toBe(normalize(snapshot.created_at));
        expect(normalize(row.closed_at)).toBe(normalize(snapshot.closed_at));
      }
    }

    // (c) getAssetDetail's owner_history reproduces the real chronological
    // sequence of members assigned to each asset, reversed (newest first).
    for (const asset of assets) {
      const detail = await getAssetDetail(db, asset.asset_id);
      const expectedNewestFirst = [...history[asset.asset_id]].reverse();
      expect(detail!.owner_history.map(h => h.ownership_id)).toEqual(expectedNewestFirst.map(h => h.ownershipId));
      expect(detail!.owner_history.map(h => h.member_id)).toEqual(expectedNewestFirst.map(h => h.memberId));
      expect(detail!.owner_history[0].to).toBeNull();
      for (const entry of detail!.owner_history.slice(1)) {
        expect(entry.to).not.toBeNull();
      }
    }
  });
});
