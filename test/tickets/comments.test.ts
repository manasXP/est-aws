import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { FakePushAdapter } from '../../aws-blocks/notifications/push-adapter';
import { raiseTicket } from '../../aws-blocks/tickets/tickets';
import {
  pickupTicket,
  resolveTicket,
  withdrawTicket,
  autoCloseResolvedTickets,
  TicketLifecycleConflictError,
} from '../../aws-blocks/tickets/lifecycle';
import { addComment, getTicketThread } from '../../aws-blocks/tickets/comments';

// STR-123 — the ticket comment thread (Member Requests: "threaded
// conversation between the member and staff; append-only"). Follows the
// repo test pattern: fresh Database + Scope per test, all migrations
// applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-123-test-${randomUUID()}`), 'db');
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

async function adminEmployee(db: Database, name = `Admin ${randomUUID()}`): Promise<string> {
  const employee = await createEmployee(db, { name });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

async function registerDevice(db: Database, memberId: string, token: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO registered_devices (id, member_id, platform, push_token)
        VALUES (${randomUUID()}, ${memberId}, 'ios', ${token})`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('STR-123 T-U1 — the thread preserves order and authorship across both surfaces (covers TC-TKT-020)', () => {
  it('interleaved member and staff comments read back in the order posted, each correctly attributed', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db, 'Priya Desai');
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift stuck on 3.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'member', member.member_id, 'Any update?');
    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Technician booked for tomorrow.');
    await addComment(db, adapter, ticket.ticketId, 'member', member.member_id, 'Thank you.');

    const thread = await getTicketThread(db, ticket.ticketId);
    expect(thread.map(c => [c.authorKind, c.authorName, c.body])).toEqual([
      ['member', 'Asha Rao', 'Any update?'],
      ['staff', 'Priya Desai', 'Technician booked for tomorrow.'],
      ['member', 'Asha Rao', 'Thank you.'],
    ]);
  });

  it('both surfaces append to one shared thread, not two', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'member', member.member_id, 'One.');
    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Two.');

    const rows = await db.query<{ count: string | number }>(
      sql`SELECT COUNT(*) AS count FROM ticket_comments WHERE ticket_id = ${ticket.ticketId}`,
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it('rejects an empty comment body, appending nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await expect(addComment(db, adapter, ticket.ticketId, 'member', member.member_id, '')).rejects.toThrow();

    expect(await getTicketThread(db, ticket.ticketId)).toEqual([]);
  });
});

describe('STR-123 T-U2 — staff replies push, member replies do not (covers TC-TKT-020)', () => {
  it('a staff reply enqueues exactly one push per device registered to the ticket owner', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    await registerDevice(db, member.member_id, 'token-a');
    await registerDevice(db, member.member_id, 'token-b');
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Looking into it.');

    expect(adapter.sent.map(s => s.pushToken).sort()).toEqual(['token-a', 'token-b']);
  });

  it('a member reply enqueues no push at all', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    await registerDevice(db, member.member_id, 'token-a');
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'member', member.member_id, 'Any update?');

    expect(adapter.sent).toEqual([]);
  });

  it('a staff reply never pushes to a different member with devices', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const staff = await adminEmployee(db);
    await registerDevice(db, other.member_id, 'other-token');
    await registerDevice(db, member.member_id, 'mine');
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Looking into it.');

    expect(adapter.sent.map(s => s.pushToken)).toEqual(['mine']);
  });

  it('the reply push copy is distinct from the resolution push copy', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    await registerDevice(db, member.member_id, 'token-a');
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Looking into it.');
    await pickupTicket(db, ticket.ticketId, staff);
    await resolveTicket(db, ticket.ticketId, staff, 'Fixed.', adapter);

    const [reply, resolution] = adapter.sent;
    expect(reply.notification).not.toEqual(resolution.notification);
  });
});

describe('STR-123 T-U3 — a terminal ticket has a read-only thread (covers TC-TKT-008)', () => {
  async function closedTicket(db: Database, memberId: string, staff: string): Promise<string> {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, staff);
    await resolveTicket(db, ticket.ticketId, staff, 'Answered.', new FakePushAdapter());
    await db.execute(
      sql`UPDATE tickets SET resolved_at = ${new Date(now.getTime() - 7 * DAY_MS).toISOString()} WHERE id = ${ticket.ticketId}`,
    );
    await autoCloseResolvedTickets(db, now);
    return ticket.ticketId;
  }

  it('rejects a member comment on a closed ticket, adding no row', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticketId = await closedTicket(db, member.member_id, staff);
    const adapter = new FakePushAdapter();

    await expect(addComment(db, adapter, ticketId, 'member', member.member_id, 'One more thing.')).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await getTicketThread(db, ticketId)).toEqual([]);
  });

  it('rejects a staff comment on a closed ticket, adding no row and pushing nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    await registerDevice(db, member.member_id, 'token-a');
    const ticketId = await closedTicket(db, member.member_id, staff);
    const adapter = new FakePushAdapter();

    await expect(addComment(db, adapter, ticketId, 'staff', staff, 'One more thing.')).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await getTicketThread(db, ticketId)).toEqual([]);
    expect(adapter.sent).toEqual([]);
  });

  it('rejects a comment on a withdrawn ticket from either surface', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await withdrawTicket(db, ticket.ticketId, member.member_id);
    const adapter = new FakePushAdapter();

    await expect(
      addComment(db, adapter, ticket.ticketId, 'member', member.member_id, 'Hello?'),
    ).rejects.toBeInstanceOf(TicketLifecycleConflictError);
    await expect(addComment(db, adapter, ticket.ticketId, 'staff', staff, 'Hello?')).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await getTicketThread(db, ticket.ticketId)).toEqual([]);
  });

  it('still accepts comments on open, in_progress, and resolved tickets', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const adapter = new FakePushAdapter();

    const open = await raiseTicket(db, member.member_id, 'general', 'A', 'a');
    await addComment(db, adapter, open.ticketId, 'member', member.member_id, 'on open');

    const inProgress = await raiseTicket(db, member.member_id, 'general', 'B', 'b');
    await pickupTicket(db, inProgress.ticketId, staff);
    await addComment(db, adapter, inProgress.ticketId, 'member', member.member_id, 'on in_progress');

    const resolved = await raiseTicket(db, member.member_id, 'general', 'C', 'c');
    await pickupTicket(db, resolved.ticketId, staff);
    await resolveTicket(db, resolved.ticketId, staff, 'done', adapter);
    await addComment(db, adapter, resolved.ticketId, 'member', member.member_id, 'on resolved');

    expect(await getTicketThread(db, open.ticketId)).toHaveLength(1);
    expect(await getTicketThread(db, inProgress.ticketId)).toHaveLength(1);
    expect(await getTicketThread(db, resolved.ticketId)).toHaveLength(1);
  });
});

describe('STR-123 T-U4 — a member cannot comment on another member\'s ticket', () => {
  it('rejects the comment and adds no row', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await expect(addComment(db, adapter, ticket.ticketId, 'member', other.member_id, 'Nosy.')).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await getTicketThread(db, ticket.ticketId)).toEqual([]);
  });

  it('staff may comment on any member\'s ticket — the ownership check is member-only', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const adapter = new FakePushAdapter();

    await addComment(db, adapter, ticket.ticketId, 'staff', staff, 'On it.');

    expect(await getTicketThread(db, ticket.ticketId)).toHaveLength(1);
  });

  it('rejects a comment on a ticket that does not exist', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const adapter = new FakePushAdapter();

    await expect(
      addComment(db, adapter, randomUUID(), 'member', member.member_id, 'Hello?'),
    ).rejects.toBeInstanceOf(TicketLifecycleConflictError);
  });
});
