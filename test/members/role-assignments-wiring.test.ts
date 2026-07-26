import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, admitMember, suspendMember } from '../../aws-blocks/members/members-api';

// STR-041 code review Finding 1 — role-assignments.ts registers its STR-032
// vacation listener (vacateRolesOnStatusChange) as a module-load side
// effect. That only fires if something in the running app's import graph
// actually imports role-assignments.ts; test/members/role-assignments.test.ts
// importing it directly was masking a real gap, since aws-blocks/index.ts
// (the production entrypoint) never did.
//
// This test deliberately imports ONLY aws-blocks/index.ts (the real app
// entrypoint, same pattern as test/contract/members.contract.test.ts) and
// aws-blocks/members/members-api.ts (which role-assignments.ts depends on,
// not the other way around) — never aws-blocks/members/role-assignments.ts
// itself. A role_assignments row is seeded with raw SQL rather than via
// assignRole, so the listener wiring under test is exercised only through
// index.ts's own side-effect import, not a side channel opened by this test
// file.
beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

describe('STR-041 code review Finding 1 — role vacation listener registers via the real app entrypoint', () => {
  it('vacates an open role when suspendMember runs through aws-blocks/index.ts, not a direct role-assignments.ts import', async () => {
    const member = await createMember(db, { name: `Wiring Test Member ${randomUUID()}` });
    await admitMember(db, member.member_id);

    const roleAssignmentId = randomUUID();
    await db.execute(
      sql`INSERT INTO role_assignments (id, member_id, role, effective_from, acting_admin)
          VALUES (${roleAssignmentId}, ${member.member_id}, 'management', '2026-01-01', 'ec-admin')`,
    );

    await suspendMember(db, member.member_id, 'ec-admin');

    const row = await db.queryOne<{ effective_to: string | Date | null }>(
      sql`SELECT effective_to FROM role_assignments WHERE id = ${roleAssignmentId}`,
    );
    expect(row!.effective_to).not.toBeNull();
  });
});
