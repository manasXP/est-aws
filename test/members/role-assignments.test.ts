import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember, suspendMember } from '../../aws-blocks/members/members-api';
import {
  assignRole,
  vacateRole,
  listRoleAssignments,
  RoleAssignmentValidationError,
  RoleAssignmentConflictError,
  type ManagementRole,
} from '../../aws-blocks/members/role-assignments';

// STR-041 — EC role assignment with tenure history and active-status
// gating, unit cases. Follows the STR-031/032/033 test pattern (test/
// members/members-api.test.ts): fresh Database + Scope per test, baseline +
// domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-041-role-assignments-test-${randomUUID()}`), 'db');
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

// T-U1 (covers TC-MEM-020): assigning a role to a member who isn't active
// fails, and writes nothing.
describe('STR-041 T-U1 — role assignment requires an active member (covers TC-MEM-020)', () => {
  const roles: ManagementRole[] = ['management', 'treasurer'];

  it.each(roles)('rejects assigning %s to a pending member, writing nothing', async role => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Pending Member' });

    await expect(assignRole(db, member.member_id, role, '2026-01-01', 'ec-admin')).rejects.toThrow(
      RoleAssignmentConflictError,
    );

    expect(await listRoleAssignments(db, { memberId: member.member_id })).toEqual([]);
  });

  it('rejects assigning management to a suspended member, writing nothing', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'Suspended Member');
    await suspendMember(db, member.member_id, 'ec-admin');

    await expect(assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin')).rejects.toThrow(
      RoleAssignmentConflictError,
    );

    expect(await listRoleAssignments(db, { memberId: member.member_id })).toEqual([]);
  });

  it('rejects assigning management to a ceased member, writing nothing', async () => {
    const db = await freshMigratedDb();
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO members (id, name, member_status, cessation_reason) VALUES (${id}, 'Ceased Member', 'ceased', 'resigned')`,
    );

    await expect(assignRole(db, id, 'management', '2026-01-01', 'ec-admin')).rejects.toThrow(
      RoleAssignmentConflictError,
    );

    expect(await listRoleAssignments(db, { memberId: id })).toEqual([]);
  });
});

// T-U2 (covers TC-MEM-021): suspending a member holding an EC role vacates
// it atomically with the status transition; the tenure rows are preserved,
// not deleted.
describe('STR-041 T-U2 — suspension vacates held roles, preserving tenure history (covers TC-MEM-021)', () => {
  it('closes both the management prerequisite and the EC office on suspension, without deleting either row', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'EC Officer');

    await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, member.member_id, 'treasurer', '2026-01-02', 'ec-admin');

    await suspendMember(db, member.member_id, 'ec-admin');

    const rows = await listRoleAssignments(db, { memberId: member.member_id });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.effectiveTo).not.toBeNull();
    }
    const roles = rows.map(row => row.role).sort();
    expect(roles).toEqual(['management', 'treasurer']);
  });
});

// T-U3 (covers TC-MEM-022): a sequence of assignments and vacations over
// time yields a tenure history recording each holder and their period.
describe('STR-041 T-U3 — tenure history records each holder and period over time (covers TC-MEM-022)', () => {
  it('returns both the closed and the open tenure row for a role, in order', async () => {
    const db = await freshMigratedDb();
    const memberA = await activeMember(db, 'Treasurer A');
    const memberB = await activeMember(db, 'Treasurer B');

    await assignRole(db, memberA.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, memberA.member_id, 'treasurer', '2026-01-01', 'ec-admin');
    await vacateRole(db, memberA.member_id, 'treasurer', '2026-06-30', 'ec-admin');

    await assignRole(db, memberB.member_id, 'management', '2026-07-01', 'ec-admin');
    await assignRole(db, memberB.member_id, 'treasurer', '2026-07-01', 'ec-admin');

    const history = await listRoleAssignments(db, { role: 'treasurer' });

    expect(history).toHaveLength(2);
    expect(history[0]!.memberId).toBe(memberA.member_id);
    expect(history[0]!.effectiveFrom).toBe('2026-01-01');
    expect(history[0]!.effectiveTo).toBe('2026-06-30');
    expect(history[1]!.memberId).toBe(memberB.member_id);
    expect(history[1]!.effectiveFrom).toBe('2026-07-01');
    expect(history[1]!.effectiveTo).toBeNull();
  });
});

// T-U4: subset-chain violations and a non-existent member both fail.
describe('STR-041 T-U4 — subset-chain checks (EC ⊂ Management ⊂ Members)', () => {
  it('rejects assigning an EC office to an active member with no open management assignment', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'No Management Member');

    await expect(assignRole(db, member.member_id, 'treasurer', '2026-01-01', 'ec-admin')).rejects.toThrow(
      RoleAssignmentConflictError,
    );
  });

  it('rejects assigning management to a member id that does not exist', async () => {
    const db = await freshMigratedDb();

    await expect(assignRole(db, randomUUID(), 'management', '2026-01-01', 'ec-admin')).rejects.toThrow(
      RoleAssignmentValidationError,
    );
  });
});

// T-P1 (property): tenure records are append-only across a hand-rolled
// sequence of assign/vacate calls -- closing an assignment never rewrites a
// prior row, and a member's intervals for the same role never overlap. No
// fast-check dependency in this repo (STR-021's note) -- a plain hand-rolled
// sequence is the established pattern.
function intervalsOverlap(
  a: { effectiveFrom: string; effectiveTo: string | null },
  b: { effectiveFrom: string; effectiveTo: string | null },
): boolean {
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}

describe('STR-041 T-P1 — tenure history is append-only with non-overlapping intervals', () => {
  it('holds after a sequence of assign/vacate/assign/vacate cycles', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'Repeated Treasurer');
    await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');

    const cycles: Array<[string, string]> = [
      ['2026-01-01', '2026-03-31'],
      ['2026-04-01', '2026-06-30'],
      ['2026-07-01', '2026-09-30'],
    ];

    for (const [from, to] of cycles) {
      await assignRole(db, member.member_id, 'treasurer', from, 'ec-admin');
      await vacateRole(db, member.member_id, 'treasurer', to, 'ec-admin');

      const rows = await listRoleAssignments(db, { memberId: member.member_id, role: 'treasurer' });
      for (const row of rows) {
        if (row.effectiveTo === null) {
          continue;
        }
        expect(row.effectiveFrom <= row.effectiveTo).toBe(true);
      }
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          expect(intervalsOverlap(rows[i]!, rows[j]!)).toBe(false);
        }
      }
    }

    const finalRows = await listRoleAssignments(db, { memberId: member.member_id, role: 'treasurer' });
    expect(finalRows).toHaveLength(cycles.length);
    expect(finalRows.every(row => row.effectiveTo !== null)).toBe(true);
  });

  // Direct trigger probe (mirrors test/finance/journal.test.ts/reversal.test.ts
  // poking append-only constraints at the SQL level, not just through the
  // module API): a raw UPDATE that changes a column other than effective_to
  // on an already-closed row is rejected at the database level.
  it('rejects a raw UPDATE that changes effective_from on an already-closed row', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'Trigger Probe Member');
    await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
    await assignRole(db, member.member_id, 'treasurer', '2026-01-01', 'ec-admin');
    await vacateRole(db, member.member_id, 'treasurer', '2026-03-31', 'ec-admin');

    const closed = (await listRoleAssignments(db, { memberId: member.member_id, role: 'treasurer' }))[0]!;

    await expect(
      db.execute(sql`UPDATE role_assignments SET effective_from = '2025-12-01' WHERE id = ${closed.id}`),
    ).rejects.toThrow();
  });
});
