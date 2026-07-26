import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { assignRole, vacateRole } from '../../aws-blocks/members/role-assignments';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import {
  buildClaims,
  hasCapability,
  designateApprover,
  revokeApprover,
  GOVERNANCE_CAPABILITIES,
} from '../../aws-blocks/members/capabilities';

// STR-044 — capability claims builder and the PC money boundary, unit
// cases. Follows the STR-041/042/043 test pattern: fresh Database + Scope
// per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-044-capabilities-test-${randomUUID()}`), 'db');
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

/** Assigns `role` to an already-active member, holding the `management`
 * assignment role-assignments.ts requires as a prerequisite for any EC
 * office. */
async function assignEcRole(db: Database, memberId: string, role: 'treasurer' | 'president', from = '2026-01-01') {
  await assignRole(db, memberId, 'management', from, 'ec-admin');
  await assignRole(db, memberId, role, from, 'ec-admin');
}

describe('STR-044 T-U1 — claims builder derives capabilities from role assignments and employee accounts (covers TC-MEM-044 negative shape)', () => {
  it('a plain active member with no role assignment and no employee account has no capabilities', async () => {
    const db = await freshMigratedDb();
    const member = await activeMember(db, 'Plain Member');

    const claims = await buildClaims(db, { memberId: member.member_id });

    expect(claims).toEqual([]);
    expect(hasCapability(claims, 'finance-recorder')).toBe(false);
  });

  it('an employee granted designated-verifier has exactly that capability', async () => {
    const db = await freshMigratedDb();
    const employee = await createEmployee(db, { name: 'Verifier Employee' });
    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);

    const claims = await buildClaims(db, { employeeId: employee.employee_id });

    expect(hasCapability(claims, 'designated-verifier')).toBe(true);
    expect(hasCapability(claims, 'finance-recorder')).toBe(false);
    expect(hasCapability(claims, 'designated-approver')).toBe(false);
  });

  it('a request whose claims lack the endpoint capability is a deny, not just an absence check on one member', async () => {
    const db = await freshMigratedDb();
    expect(await buildClaims(db, { memberId: randomUUID() })).toEqual([]);
    expect(await buildClaims(db, { employeeId: randomUUID() })).toEqual([]);
  });
});

describe('STR-044 T-U2 — a PC-only seat confers no money capability (covers TC-MEM-044)', () => {
  it('a member sitting only on a PC (no EC role, no employee account) is denied every governance capability', async () => {
    const db = await freshMigratedDb();
    const chair = await activeMember(db, 'PC Chair');
    const project = await createProject(db, { name: 'Project A' });
    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: chair.member_id, member_ids: [chair.member_id] },
      { ownershipLookup: async () => true },
    );

    const claims = await buildClaims(db, { memberId: chair.member_id });

    expect(claims).toEqual([]);
    for (const capability of GOVERNANCE_CAPABILITIES) {
      expect(hasCapability(claims, capability)).toBe(false);
    }
  });
});

describe('STR-044 T-U3 — designated sets are configuration: no code change flips the outcome', () => {
  it('verifier: granting/revoking designated-verifier on an employee flips the claim', async () => {
    const db = await freshMigratedDb();
    const employee = await createEmployee(db, { name: 'Toggle Verifier' });

    expect(hasCapability(await buildClaims(db, { employeeId: employee.employee_id }), 'designated-verifier')).toBe(false);

    await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);
    expect(hasCapability(await buildClaims(db, { employeeId: employee.employee_id }), 'designated-verifier')).toBe(true);

    await setEmployeeCapabilities(db, employee.employee_id, []);
    expect(hasCapability(await buildClaims(db, { employeeId: employee.employee_id }), 'designated-verifier')).toBe(false);
  });

  it('approver EC subset: designating/revoking a currently-EC member flips designated-approver; a non-designated EC member never has it', async () => {
    const db = await freshMigratedDb();
    const president = await activeMember(db, 'President');
    await assignEcRole(db, president.member_id, 'president');

    expect(hasCapability(await buildClaims(db, { memberId: president.member_id }), 'designated-approver')).toBe(false);

    await designateApprover(db, president.member_id);
    expect(hasCapability(await buildClaims(db, { memberId: president.member_id }), 'designated-approver')).toBe(true);

    await revokeApprover(db, president.member_id);
    expect(hasCapability(await buildClaims(db, { memberId: president.member_id }), 'designated-approver')).toBe(false);
  });

  it('approver designation confers nothing once the member no longer holds an EC office (AC4)', async () => {
    const db = await freshMigratedDb();
    const treasurer = await activeMember(db, 'Ex EC Member');
    await assignEcRole(db, treasurer.member_id, 'treasurer');
    await designateApprover(db, treasurer.member_id);
    expect(hasCapability(await buildClaims(db, { memberId: treasurer.member_id }), 'designated-approver')).toBe(true);

    await vacateRole(db, treasurer.member_id, 'treasurer', '2026-02-01', 'ec-admin');

    expect(hasCapability(await buildClaims(db, { memberId: treasurer.member_id }), 'designated-approver')).toBe(false);
  });

  it('finance-recorder defaults to the Treasurer, is lost on vacating the role, and is separately delegable to an employee', async () => {
    const db = await freshMigratedDb();
    const treasurer = await activeMember(db, 'Treasurer');
    await assignEcRole(db, treasurer.member_id, 'treasurer');
    expect(hasCapability(await buildClaims(db, { memberId: treasurer.member_id }), 'finance-recorder')).toBe(true);

    await vacateRole(db, treasurer.member_id, 'treasurer', '2026-02-01', 'ec-admin');
    expect(hasCapability(await buildClaims(db, { memberId: treasurer.member_id }), 'finance-recorder')).toBe(false);

    const delegate = await createEmployee(db, { name: 'Finance Delegate' });
    expect(hasCapability(await buildClaims(db, { employeeId: delegate.employee_id }), 'finance-recorder')).toBe(false);
    await setEmployeeCapabilities(db, delegate.employee_id, ['finance-recorder']);
    expect(hasCapability(await buildClaims(db, { employeeId: delegate.employee_id }), 'finance-recorder')).toBe(true);
  });
});

describe('STR-044 T-P1 — the authorization decision is a pure function of (claims, capability) (property)', () => {
  it('any claim set not containing the required capability is a deny, for every governance capability and every subset', () => {
    const powerset = <T>(items: readonly T[]): T[][] =>
      items.reduce<T[][]>((subsets, item) => subsets.concat(subsets.map(subset => [...subset, item])), [[]]);

    for (const capability of GOVERNANCE_CAPABILITIES) {
      const others = GOVERNANCE_CAPABILITIES.filter(c => c !== capability);
      for (const subset of powerset(others)) {
        expect(hasCapability(subset, capability)).toBe(false);
      }
      expect(hasCapability([...others, capability], capability)).toBe(true);
    }
  });
});
