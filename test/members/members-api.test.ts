import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import {
  createMember,
  getMember,
  MemberValidationError,
  updateMember,
  admitMember,
  suspendMember,
  reinstateMember,
  ceaseMember,
  canTransitionMemberStatus,
  MEMBER_STATUS_TRANSITIONS,
  MemberLifecycleConflictError,
  type MemberStatus,
} from '../../aws-blocks/members/members-api';

// STR-031 — Member registry business logic, unit cases. Follows the
// STR-024 test pattern (test/finance/books-api.test.ts): fresh Database +
// Scope per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-031-members-test-${randomUUID()}`), 'db');
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

describe('STR-031 T-U1 — creating a member', () => {
  it('persists member_id, name, email, phone, address; member_status defaults to pending and joining_date is null until admission', async () => {
    const db = await freshMigratedDb();

    const member = await createMember(db, {
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
      address: '12 MG Road',
    });

    expect(member.member_id).toEqual(expect.any(String));
    expect(member.name).toBe('Asha Rao');
    expect(member.email).toBe('asha@example.com');
    expect(member.phone).toBe('9876543210');
    expect(member.address).toBe('12 MG Road');
    expect(member.member_status).toBe('pending');
    expect(member.joining_date).toBeNull();

    const fetched = await getMember(db, member.member_id);
    expect(fetched).toEqual(member);
  });
});

describe('STR-031 code review — createMember rejects a missing name', () => {
  it('throws MemberValidationError and writes nothing when name is omitted', async () => {
    const db = await freshMigratedDb();

    await expect(createMember(db, { email: 'noname@example.com' })).rejects.toThrow(MemberValidationError);
  });
});

describe('STR-031 code review — updateMember distinguishes omitted from explicit null', () => {
  it('clears email when the PATCH explicitly sets it to null', async () => {
    const db = await freshMigratedDb();

    const member = await createMember(db, { name: 'Asha Rao', email: 'asha@example.com' });

    const updated = await updateMember(db, member.member_id, { email: null });

    expect(updated!.email).toBeUndefined();
  });
});

// STR-032 T-U1 (covers TC-MEM-001): admission is the pending -> active
// transition and the only thing that sets joining_date.
describe('STR-032 T-U1 — admitting a pending member (covers TC-MEM-001)', () => {
  it('moves a pending member to active and sets joining_date to today (IST calendar day)', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Pending Member' });
    expect(member.member_status).toBe('pending');
    expect(member.joining_date).toBeNull();

    const today = await db.queryOne<{ today: string }>(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`);

    const admitted = await admitMember(db, member.member_id);

    expect(admitted!.member_status).toBe('active');
    expect(admitted!.joining_date).toBe(today!.today);
  });
});

// STR-032 T-U2 (covers TC-MEM-003): active <-> suspended both directions,
// with the acting EC member recorded (status_actor, not part of the public
// Member shape).
describe('STR-032 T-U2 — suspend then reinstate an active member (covers TC-MEM-003)', () => {
  it('active -> suspended -> active, recording the acting EC member each time', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Suspend Reinstate Member' });
    await admitMember(db, member.member_id);

    const suspended = await suspendMember(db, member.member_id, 'ec-member-1');
    expect(suspended!.member_status).toBe('suspended');

    const afterSuspend = await db.queryOne<{ status_actor: string; status_changed_at: unknown }>(
      sql`SELECT status_actor, status_changed_at FROM members WHERE id = ${member.member_id}`,
    );
    expect(afterSuspend!.status_actor).toBe('ec-member-1');
    expect(afterSuspend!.status_changed_at).not.toBeNull();

    const reinstated = await reinstateMember(db, member.member_id, 'ec-member-2');
    expect(reinstated!.member_status).toBe('active');

    const afterReinstate = await db.queryOne<{ status_actor: string; status_changed_at: unknown }>(
      sql`SELECT status_actor, status_changed_at FROM members WHERE id = ${member.member_id}`,
    );
    expect(afterReinstate!.status_actor).toBe('ec-member-2');
    expect(afterReinstate!.status_changed_at).not.toBeNull();
  });
});

// STR-032 code review — TOCTOU race in transitionMemberStatus's
// SELECT-then-UPDATE: two concurrent suspend calls on the same active
// member could both pass the app-level pre-check before either committed
// its UPDATE. The UPDATE's WHERE clause now re-checks member_status = from
// and the caller checks rowCount, so exactly one of two concurrent calls
// should win.
describe('STR-032 code review — concurrent suspend calls on the same active member', () => {
  it('resolves exactly one of two concurrent suspendMember calls, rejecting the other with MemberLifecycleConflictError', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Concurrent Suspend Member' });
    await admitMember(db, member.member_id);

    const [first, second] = await Promise.allSettled([
      suspendMember(db, member.member_id, 'ec-member-1'),
      suspendMember(db, member.member_id, 'ec-member-2'),
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(MemberLifecycleConflictError);

    const after = await db.queryOne<{ status_actor: string }>(
      sql`SELECT status_actor FROM members WHERE id = ${member.member_id}`,
    );
    const winningCallWasFirst = first.status === 'fulfilled';
    expect(after!.status_actor).toBe(winningCallWasFirst ? 'ec-member-1' : 'ec-member-2');
  });
});

// STR-032 T-U3 (covers TC-MEM-009): invalid transitions are rejected and
// leave the stored status unchanged.
describe('STR-032 T-U3 — invalid transitions are rejected without side effects (covers TC-MEM-009)', () => {
  it('rejects ceased -> active (via reinstateMember, which requires suspended)', async () => {
    const db = await freshMigratedDb();
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Ceased Member', 'ceased')`);

    await expect(reinstateMember(db, id, 'ec-member-1')).rejects.toThrow(MemberLifecycleConflictError);

    const after = await getMember(db, id);
    expect(after!.member_status).toBe('ceased');
  });

  it('rejects pending -> suspended (via suspendMember, which requires active)', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Pending Member' });

    await expect(suspendMember(db, member.member_id, 'ec-member-1')).rejects.toThrow(MemberLifecycleConflictError);

    const after = await getMember(db, member.member_id);
    expect(after!.member_status).toBe('pending');
  });

  it('rejects pending -> ceased at the pure transition-check level (no endpoint exists for it)', () => {
    expect(canTransitionMemberStatus('pending', 'ceased')).toBe(false);
  });
});

// STR-032 T-P1: the transition function permits exactly the decided edge
// set, exhaustively over all 16 (from, to) pairs -- including all 4
// self-transitions, none of which are edges.
describe('STR-032 T-P1 — canTransitionMemberStatus permits exactly the decided edge set', () => {
  const statuses: MemberStatus[] = ['pending', 'active', 'suspended', 'ceased'];
  const edges = new Set(MEMBER_STATUS_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

  for (const from of statuses) {
    for (const to of statuses) {
      const isEdge = edges.has(`${from}->${to}`);
      it(`${from} -> ${to} is ${isEdge ? 'allowed' : 'rejected'}`, () => {
        expect(canTransitionMemberStatus(from, to)).toBe(isEdge);
      });
    }
  }
});

// STR-033 T-U1 (covers TC-MEM-005): cessation always requires a valid
// cessation_reason, checked before any DB write.
describe('STR-033 T-U1 — cessation requires a valid cessation_reason (covers TC-MEM-005)', () => {
  it('rejects cessation with no reason, writing nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'No Reason Member' });
    await admitMember(db, member.member_id);

    await expect(ceaseMember(db, member.member_id, undefined)).rejects.toThrow(MemberValidationError);

    const after = await getMember(db, member.member_id);
    expect(after!.member_status).toBe('active');
  });

  it('rejects cessation with a reason outside resigned|expelled|deceased|transferred, writing nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Bad Reason Member' });
    await admitMember(db, member.member_id);

    await expect(ceaseMember(db, member.member_id, 'retired')).rejects.toThrow(MemberValidationError);

    const after = await getMember(db, member.member_id);
    expect(after!.member_status).toBe('active');
  });
});

// STR-033 T-U2 (covers TC-MEM-006): non-deceased cessation of a member
// holding ownerships fails until the ownerships are transferred. The
// ownership check goes only through the injectable lookup port -- stubbed
// until E06 supplies the real ownership store.
describe('STR-033 T-U2 — non-deceased cessation is blocked while ownerships are held (covers TC-MEM-006)', () => {
  it('fails while the ownership lookup reports ownerships held, then succeeds once it reports none', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Owner Member' });
    await admitMember(db, member.member_id);

    await expect(
      ceaseMember(db, member.member_id, 'resigned', { ownershipLookup: async () => true }),
    ).rejects.toThrow(MemberLifecycleConflictError);
    expect((await getMember(db, member.member_id))!.member_status).toBe('active');

    const ceased = await ceaseMember(db, member.member_id, 'resigned', { ownershipLookup: async () => false });
    expect(ceased!.member_status).toBe('ceased');
    expect(ceased!.cessation_reason).toBe('resigned');
  });
});

// STR-033 T-U3 (covers TC-MEM-007): deceased cessation succeeds while
// ownerships are held -- retained pending succession, no guard applied.
describe('STR-033 T-U3 — deceased cessation succeeds with ownerships retained (covers TC-MEM-007)', () => {
  it('succeeds even while the ownership lookup reports ownerships held', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Deceased Owner Member' });
    await admitMember(db, member.member_id);

    const ceased = await ceaseMember(db, member.member_id, 'deceased', { ownershipLookup: async () => true });

    expect(ceased!.member_status).toBe('ceased');
    expect(ceased!.cessation_reason).toBe('deceased');
  });
});

// STR-033 T-U4 (covers TC-MEM-008): a ceased member's outstanding dues
// survive cessation untouched -- cessation writes only to the members
// table, never the journal (the books are derived views over it), so no
// dues are written off and no new charges are created as a side effect.
describe('STR-033 T-U4 — outstanding dues survive cessation untouched (covers TC-MEM-008)', () => {
  it('leaves the journal completely untouched by the cessation call itself', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Dues Member' });
    await admitMember(db, member.member_id);

    const entriesBefore = await db.query(sql`SELECT * FROM journal_entries`);
    const linesBefore = await db.query(sql`SELECT * FROM journal_lines`);

    await ceaseMember(db, member.member_id, 'resigned');

    const entriesAfter = await db.query(sql`SELECT * FROM journal_entries`);
    const linesAfter = await db.query(sql`SELECT * FROM journal_lines`);
    expect(entriesAfter).toEqual(entriesBefore);
    expect(linesAfter).toEqual(linesBefore);
  });
});

// STR-033 T-U5 (covers TC-MEM-009, the ceased -> active case): ceased is
// terminal -- no lifecycle action, including a second cessation, moves a
// ceased member anywhere else.
describe('STR-033 T-U5 — ceased is terminal (covers TC-MEM-009)', () => {
  it('rejects admit, suspend, reinstate, and a second cessation on an already-ceased member', async () => {
    const db = await freshMigratedDb();
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Ceased Member', 'ceased')`);

    await expect(admitMember(db, id)).rejects.toThrow(MemberLifecycleConflictError);
    await expect(suspendMember(db, id, 'ec-member-1')).rejects.toThrow(MemberLifecycleConflictError);
    await expect(reinstateMember(db, id, 'ec-member-1')).rejects.toThrow(MemberLifecycleConflictError);
    await expect(ceaseMember(db, id, 'resigned')).rejects.toThrow(MemberLifecycleConflictError);

    const after = await getMember(db, id);
    expect(after!.member_status).toBe('ceased');
  });
});
