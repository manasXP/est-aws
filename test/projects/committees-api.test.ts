import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember, suspendMember, ceaseMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import {
  createCommittee,
  getProjectCommittee,
  setProjectCommittee,
  CommitteeConflictError,
  CommitteeEligibilityError,
  type ProjectOwnershipLookupPort,
} from '../../aws-blocks/projects/committees-api';

// STR-043 — Project committee (PC) appointment and composition, unit
// cases. Follows the STR-041 test pattern (test/members/
// role-assignments.test.ts): fresh Database + Scope per test, baseline +
// domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-043-committees-test-${randomUUID()}`), 'db');
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

/** Creates a member and admits them, landing at `active`. */
async function activeMember(db: Database, name: string) {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  return member;
}

/** An ownership lookup that answers `true` for exactly the given (member, project) pairs. */
function ownershipAmong(pairs: ReadonlyArray<[string, string]>): ProjectOwnershipLookupPort {
  return async (_db, memberId, projectId) => pairs.some(([m, p]) => m === memberId && p === projectId);
}

// T-U1 (covers TC-MEM-040): a PC appointment including a candidate with no
// ownership in the project is rejected, writing nothing.
describe('STR-043 T-U1 — appointment requires in-project ownership (covers TC-MEM-040)', () => {
  it('rejects a chair/member list containing a member with no ownership in the project, writing nothing', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Green Meadows' });
    const owner = await activeMember(db, 'In-Project Owner');
    const outsider = await activeMember(db, 'No Ownership Member');

    await expect(
      setProjectCommittee(
        db,
        project.project_id,
        { chair_member_id: owner.member_id, member_ids: [owner.member_id, outsider.member_id] },
        { ownershipLookup: ownershipAmong([[owner.member_id, project.project_id]]) },
      ),
    ).rejects.toThrow(CommitteeEligibilityError);

    const committeeRows = await db.query(sql`SELECT * FROM project_committees WHERE project_id = ${project.project_id}`);
    expect(committeeRows).toHaveLength(0);

    const composition = await getProjectCommittee(db, project.project_id);
    expect(composition).toEqual({ project_id: project.project_id, chair_member_id: null, member_ids: [], updated_at: null });
  });

  it('rejects an appointment when the default ownership stub is used (every attempt fails until E06)', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Blue Ridge' });
    const owner = await activeMember(db, 'Would-Be Owner');

    await expect(
      setProjectCommittee(db, project.project_id, { chair_member_id: owner.member_id, member_ids: [owner.member_id] }),
    ).rejects.toThrow(CommitteeEligibilityError);
  });
});

// T-U2 (covers TC-MEM-041): creating a second PC for a project that already
// has one fails.
describe('STR-043 T-U2 — at most one PC per project (covers TC-MEM-041)', () => {
  it('rejects creating a second committee for a project that already has one', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Silver Oaks' });

    await createCommittee(db, project.project_id);

    await expect(createCommittee(db, project.project_id)).rejects.toThrow(CommitteeConflictError);
  });
});

// T-U3 (covers TC-MEM-042): a member owning in several projects can sit on
// each project's PC; each PC is flat membership with exactly one designated
// Chair.
describe('STR-043 T-U3 — a member may sit on several PCs; each PC has exactly one Chair (covers TC-MEM-042)', () => {
  it('appoints the same member to two different project committees, each with a single designated Chair', async () => {
    const db = await freshMigratedDb();
    const projectA = await createProject(db, { name: 'Project A' });
    const projectB = await createProject(db, { name: 'Project B' });
    const shared = await activeMember(db, 'Multi-Project Owner');
    const otherA = await activeMember(db, 'Project A Co-Member');

    const lookup = ownershipAmong([
      [shared.member_id, projectA.project_id],
      [shared.member_id, projectB.project_id],
      [otherA.member_id, projectA.project_id],
    ]);

    const compositionA = await setProjectCommittee(
      db,
      projectA.project_id,
      { chair_member_id: shared.member_id, member_ids: [shared.member_id, otherA.member_id] },
      { ownershipLookup: lookup },
    );
    const compositionB = await setProjectCommittee(
      db,
      projectB.project_id,
      { chair_member_id: shared.member_id, member_ids: [shared.member_id] },
      { ownershipLookup: lookup },
    );

    expect(compositionA).toMatchObject({
      project_id: projectA.project_id,
      chair_member_id: shared.member_id,
      member_ids: expect.arrayContaining([shared.member_id, otherA.member_id]),
    });
    expect(compositionA!.member_ids).toHaveLength(2);
    expect(compositionB).toMatchObject({
      project_id: projectB.project_id,
      chair_member_id: shared.member_id,
      member_ids: [shared.member_id],
    });
  });
});

// T-U4: a PC seat is vacated (tenure history preserved, not deleted) when
// the member leaves `active` status (suspend or cease) -- the
// status-transition-listener path only (no TC citation, per the Red plan).
describe('STR-043 T-U4 — leaving active status vacates PC seats, preserving tenure history', () => {
  it('closes the seat (without deleting it) when a member holding a seat is suspended', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Vacation Test Project' });
    const chair = await activeMember(db, 'Chair Member');
    const other = await activeMember(db, 'Other Member');
    const lookup = ownershipAmong([
      [chair.member_id, project.project_id],
      [other.member_id, project.project_id],
    ]);

    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: chair.member_id, member_ids: [chair.member_id, other.member_id] },
      { ownershipLookup: lookup },
    );

    await suspendMember(db, chair.member_id, 'ec-admin');

    const composition = await getProjectCommittee(db, project.project_id);
    expect(composition!.member_ids).toEqual([other.member_id]);
    expect(composition!.chair_member_id).toBeNull();

    const seatRows = await db.query<{ member_id: string; effective_to: unknown }>(
      sql`SELECT member_id, effective_to FROM project_committee_seats WHERE member_id = ${chair.member_id}`,
    );
    expect(seatRows).toHaveLength(1);
    expect(seatRows[0]!.effective_to).not.toBeNull();
  });

  it('closes the seat (without deleting it) when a member holding a seat ceases membership', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Cessation Test Project' });
    const member = await activeMember(db, 'Ceasing Member');
    const lookup = ownershipAmong([[member.member_id, project.project_id]]);

    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: member.member_id, member_ids: [member.member_id] },
      { ownershipLookup: lookup },
    );

    await ceaseMember(db, member.member_id, 'resigned');

    const composition = await getProjectCommittee(db, project.project_id);
    expect(composition).toEqual({ project_id: project.project_id, chair_member_id: null, member_ids: [], updated_at: null });

    const seatRows = await db.query<{ member_id: string; effective_to: unknown }>(
      sql`SELECT member_id, effective_to FROM project_committee_seats WHERE member_id = ${member.member_id}`,
    );
    expect(seatRows).toHaveLength(1);
    expect(seatRows[0]!.effective_to).not.toBeNull();
  });
});

// Direct trigger probe (mirrors test/members/role-assignments.test.ts's
// "rejects a raw UPDATE that changes effective_from on an already-closed
// row"): the append-only trigger on project_committee_seats rejects illegal
// mutations at the SQL level.
describe('STR-043 — project_committee_seats append-only trigger', () => {
  it('rejects a raw UPDATE that changes effective_from on an already-closed row', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Trigger Probe Project' });
    const memberA = await activeMember(db, 'Trigger Probe Member A');
    const memberB = await activeMember(db, 'Trigger Probe Member B');
    const lookup = ownershipAmong([
      [memberA.member_id, project.project_id],
      [memberB.member_id, project.project_id],
    ]);

    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: memberA.member_id, member_ids: [memberA.member_id] },
      { ownershipLookup: lookup },
    );
    // Replacing the composition closes memberA's seat.
    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: memberB.member_id, member_ids: [memberB.member_id] },
      { ownershipLookup: lookup },
    );

    const closed = (
      await db.query<{ id: string; effective_to: unknown }>(
        sql`SELECT id, effective_to FROM project_committee_seats WHERE member_id = ${memberA.member_id}`,
      )
    )[0]!;
    expect(closed.effective_to).not.toBeNull();

    await expect(
      db.execute(sql`UPDATE project_committee_seats SET effective_from = '2025-12-01' WHERE id = ${closed.id}`),
    ).rejects.toThrow();
  });

  it('rejects a raw DELETE of a seat row', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Delete Probe Project' });
    const member = await activeMember(db, 'Delete Probe Member');
    const lookup = ownershipAmong([[member.member_id, project.project_id]]);

    await setProjectCommittee(db, project.project_id, { chair_member_id: member.member_id, member_ids: [member.member_id] }, { ownershipLookup: lookup });

    const seat = (
      await db.query<{ id: string }>(sql`SELECT id FROM project_committee_seats WHERE member_id = ${member.member_id}`)
    )[0]!;

    await expect(db.execute(sql`DELETE FROM project_committee_seats WHERE id = ${seat.id}`)).rejects.toThrow();
  });
});

// Partial unique index probe: a member can't hold two simultaneously-open
// seats on the same committee (TOCTOU backstop for the close-then-insert
// replace in setProjectCommittee).
describe('STR-043 — project_committee_seats_open_unique partial index', () => {
  it('rejects inserting a second open seat for the same (committee, member)', async () => {
    const db = await freshMigratedDb();
    const project = await createProject(db, { name: 'Unique Index Probe Project' });
    const member = await activeMember(db, 'Unique Index Probe Member');
    const lookup = ownershipAmong([[member.member_id, project.project_id]]);

    await setProjectCommittee(db, project.project_id, { chair_member_id: member.member_id, member_ids: [member.member_id] }, { ownershipLookup: lookup });

    const committeeRow = (
      await db.query<{ id: string }>(sql`SELECT id FROM project_committees WHERE project_id = ${project.project_id}`)
    )[0]!;

    await expect(
      db.execute(
        sql`INSERT INTO project_committee_seats (id, committee_id, member_id, is_chair, effective_from) VALUES (${randomUUID()}, ${committeeRow.id}, ${member.member_id}, false, '2026-01-01')`,
      ),
    ).rejects.toThrow();
  });
});
