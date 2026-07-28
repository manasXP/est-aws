import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { FakePushAdapter } from '../../aws-blocks/notifications/push-adapter';
import { raiseTicket, replaceTicketRouting, TicketValidationError } from '../../aws-blocks/tickets/tickets';
import {
  pickupTicket,
  resolveTicket,
  reopenTicket,
  withdrawTicket,
  autoCloseResolvedTickets,
  TicketLifecycleConflictError,
} from '../../aws-blocks/tickets/lifecycle';

// STR-122 — the ticket lifecycle state machine (Member Requests spec's
// lifecycle diagram). Follows the repo test pattern established by
// test/tickets/tickets.test.ts: fresh Database + Scope per test, all
// migrations applied via MIGRATIONS_DIR.
//
// Every transition is driven through lifecycle.ts rather than raw SQL, so
// these cases pin the *reachable* state graph, not just column writes.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-122-test-${randomUUID()}`), 'db');
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

/** An employee WITH an admin account — ticket routing requires one (STR-121). */
async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Admin ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

async function routeAllTo(db: Database, employeeId: string): Promise<void> {
  await replaceTicketRouting(db, {
    finance: employeeId,
    maintenance: employeeId,
    records: employeeId,
    general: employeeId,
  });
}

async function statusOf(db: Database, ticketId: string): Promise<string> {
  const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM tickets WHERE id = ${ticketId}`);
  return row!.status;
}

async function actionsOf(db: Database, ticketId: string): Promise<{ action: string; actor_id: string }[]> {
  return db.query<{ action: string; actor_id: string }>(
    sql`SELECT action, actor_id FROM ticket_actions WHERE ticket_id = ${ticketId} ORDER BY at`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('STR-122 T-U1 — pickup moves open → in_progress and applies category routing (covers TC-TKT-002)', () => {
  it('picking up with no explicit assignee assigns the category default', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    // Raised BEFORE routing exists, so assignee_id starts null — proving
    // pickup re-resolves routing rather than reading the creation-time value.
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift stuck on 3.');
    const routed = await adminEmployee(db);
    await routeAllTo(db, routed);

    const picked = await pickupTicket(db, ticket.ticketId, admin);

    expect(picked.status).toBe('in_progress');
    expect(picked.assigneeId).toBe(routed);
  });

  it('picking up with an explicit assignee overrides the category default', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const routed = await adminEmployee(db);
    const specific = await adminEmployee(db);
    await routeAllTo(db, routed);
    const ticket = await raiseTicket(db, member.member_id, 'finance', 'Wrong charge', 'Billed twice.');

    const picked = await pickupTicket(db, ticket.ticketId, admin, specific);

    expect(picked.status).toBe('in_progress');
    expect(picked.assigneeId).toBe(specific);
  });
});

describe('STR-122 T-U2 — resolve requires a note and pushes the member (covers TC-TKT-003)', () => {
  it('rejects a resolve with no resolution_note, leaving the status unchanged', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    const adapter = new FakePushAdapter();

    await expect(resolveTicket(db, ticket.ticketId, admin, '', adapter)).rejects.toBeInstanceOf(TicketValidationError);

    expect(await statusOf(db, ticket.ticketId)).toBe('in_progress');
    expect(adapter.sent).toEqual([]);
  });

  it('resolves with a note, stores it, sets resolved_at, and pushes once per registered device', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    for (const platform of ['ios', 'android']) {
      await db.execute(
        sql`INSERT INTO registered_devices (id, member_id, platform, push_token)
            VALUES (${randomUUID()}, ${member.member_id}, ${platform}, ${`token-${platform}`})`,
      );
    }
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    const adapter = new FakePushAdapter();

    const resolved = await resolveTicket(db, ticket.ticketId, admin, 'Answered by phone.', adapter);

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBe('Answered by phone.');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(adapter.sent.map(s => s.pushToken).sort()).toEqual(['token-android', 'token-ios']);
  });

  it('pushes only to the raising member, never to another member with devices', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const admin = await adminEmployee(db);
    await db.execute(
      sql`INSERT INTO registered_devices (id, member_id, platform, push_token)
          VALUES (${randomUUID()}, ${other.member_id}, 'ios', 'other-token')`,
    );
    await db.execute(
      sql`INSERT INTO registered_devices (id, member_id, platform, push_token)
          VALUES (${randomUUID()}, ${member.member_id}, 'ios', 'mine')`,
    );
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    const adapter = new FakePushAdapter();

    await resolveTicket(db, ticket.ticketId, admin, 'Done.', adapter);

    expect(adapter.sent.map(s => s.pushToken)).toEqual(['mine']);
  });
});

describe('STR-122 T-U3 — auto-close fires at exactly 7 days (covers TC-TKT-004)', () => {
  /** A resolved ticket whose resolved_at is pinned to `resolvedAt`. */
  async function resolvedTicketAgedTo(db: Database, memberId: string, admin: string, resolvedAt: Date): Promise<string> {
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    await resolveTicket(db, ticket.ticketId, admin, 'Answered.', new FakePushAdapter());
    await db.execute(sql`UPDATE tickets SET resolved_at = ${resolvedAt.toISOString()} WHERE id = ${ticket.ticketId}`);
    return ticket.ticketId;
  }

  it('closes a ticket resolved exactly 7 days ago, terminal with closed_at and actor "system"', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticketId = await resolvedTicketAgedTo(db, member.member_id, admin, new Date(now.getTime() - 7 * DAY_MS));

    await autoCloseResolvedTickets(db, now);

    expect(await statusOf(db, ticketId)).toBe('closed');
    const row = await db.queryOne<{ closed_at: string | Date | null }>(
      sql`SELECT closed_at FROM tickets WHERE id = ${ticketId}`,
    );
    expect(row!.closed_at).not.toBeNull();
    expect(await actionsOf(db, ticketId)).toContainEqual({ action: 'closed', actor_id: 'system' });
  });

  it('leaves a ticket resolved 6 days 23 hours ago untouched', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticketId = await resolvedTicketAgedTo(
      db,
      member.member_id,
      admin,
      new Date(now.getTime() - (7 * DAY_MS - 60 * 60 * 1000)),
    );

    await autoCloseResolvedTickets(db, now);

    expect(await statusOf(db, ticketId)).toBe('resolved');
    expect(await actionsOf(db, ticketId)).not.toContainEqual({ action: 'closed', actor_id: 'system' });
  });
});

describe('STR-122 T-U4 — member reopen inside the 7-day window only (covers TC-TKT-005)', () => {
  async function resolvedTicket(db: Database, memberId: string, admin: string): Promise<string> {
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    await resolveTicket(db, ticket.ticketId, admin, 'Answered.', new FakePushAdapter());
    return ticket.ticketId;
  }

  it('returns a resolved ticket to open when the raising member reopens within the window', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticketId = await resolvedTicket(db, member.member_id, admin);

    const reopened = await reopenTicket(db, ticketId, member.member_id, new Date());

    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeNull();
  });

  it('fails 409 once the ticket has auto-closed, leaving it closed', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticketId = await resolvedTicket(db, member.member_id, admin);
    await db.execute(
      sql`UPDATE tickets SET resolved_at = ${new Date(now.getTime() - 7 * DAY_MS).toISOString()} WHERE id = ${ticketId}`,
    );
    await autoCloseResolvedTickets(db, now);

    await expect(reopenTicket(db, ticketId, member.member_id, now)).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await statusOf(db, ticketId)).toBe('closed');
  });

  it('fails 409 past the 7-day window even if the auto-close run has not yet fired (AC4)', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticketId = await resolvedTicket(db, member.member_id, admin);
    await db.execute(
      sql`UPDATE tickets SET resolved_at = ${new Date(now.getTime() - 8 * DAY_MS).toISOString()} WHERE id = ${ticketId}`,
    );

    await expect(reopenTicket(db, ticketId, member.member_id, now)).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await statusOf(db, ticketId)).toBe('resolved');
  });

  it('fails for a member who did not raise the ticket', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const admin = await adminEmployee(db);
    const ticketId = await resolvedTicket(db, member.member_id, admin);

    await expect(reopenTicket(db, ticketId, other.member_id, new Date())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await statusOf(db, ticketId)).toBe('resolved');
  });
});

describe('STR-122 T-U5 — member withdraw before resolution only (covers TC-TKT-006)', () => {
  it('withdraws an open ticket to the terminal withdrawn state', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    const withdrawn = await withdrawTicket(db, ticket.ticketId, member.member_id);

    expect(withdrawn.status).toBe('withdrawn');
  });

  it('withdraws an in_progress ticket', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);

    const withdrawn = await withdrawTicket(db, ticket.ticketId, member.member_id);

    expect(withdrawn.status).toBe('withdrawn');
  });

  it('fails 409 on a resolved ticket, leaving it resolved', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    await resolveTicket(db, ticket.ticketId, admin, 'Answered.', new FakePushAdapter());

    await expect(withdrawTicket(db, ticket.ticketId, member.member_id)).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await statusOf(db, ticket.ticketId)).toBe('resolved');
  });

  it('fails for a member who did not raise the ticket', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    await expect(withdrawTicket(db, ticket.ticketId, other.member_id)).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await statusOf(db, ticket.ticketId)).toBe('open');
  });
});

describe('STR-122 T-U6 — closed and withdrawn are terminal (covers TC-TKT-007)', () => {
  async function closedTicket(db: Database, memberId: string, admin: string): Promise<string> {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    await resolveTicket(db, ticket.ticketId, admin, 'Answered.', new FakePushAdapter());
    await db.execute(
      sql`UPDATE tickets SET resolved_at = ${new Date(now.getTime() - 7 * DAY_MS).toISOString()} WHERE id = ${ticket.ticketId}`,
    );
    await autoCloseResolvedTickets(db, now);
    return ticket.ticketId;
  }

  async function withdrawnTicket(db: Database, memberId: string): Promise<string> {
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await withdrawTicket(db, ticket.ticketId, memberId);
    return ticket.ticketId;
  }

  it('no transition mutates a closed ticket', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticketId = await closedTicket(db, member.member_id, admin);
    const before = await actionsOf(db, ticketId);

    await expect(pickupTicket(db, ticketId, admin)).rejects.toBeInstanceOf(TicketLifecycleConflictError);
    await expect(resolveTicket(db, ticketId, admin, 'note', new FakePushAdapter())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );
    await expect(reopenTicket(db, ticketId, member.member_id, new Date())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );
    await expect(withdrawTicket(db, ticketId, member.member_id)).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await statusOf(db, ticketId)).toBe('closed');
    expect(await actionsOf(db, ticketId)).toEqual(before);
  });

  it('no transition mutates a withdrawn ticket', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticketId = await withdrawnTicket(db, member.member_id);
    const before = await actionsOf(db, ticketId);

    await expect(pickupTicket(db, ticketId, admin)).rejects.toBeInstanceOf(TicketLifecycleConflictError);
    await expect(resolveTicket(db, ticketId, admin, 'note', new FakePushAdapter())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );
    await expect(reopenTicket(db, ticketId, member.member_id, new Date())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );
    await expect(withdrawTicket(db, ticketId, member.member_id)).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await statusOf(db, ticketId)).toBe('withdrawn');
    expect(await actionsOf(db, ticketId)).toEqual(before);
  });

  it('a withdrawn ticket is never revived by the auto-close run', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticketId = await withdrawnTicket(db, member.member_id);

    await autoCloseResolvedTickets(db, new Date('2030-01-01T00:00:00.000Z'));

    expect(await statusOf(db, ticketId)).toBe('withdrawn');
  });
});

describe('STR-122 T-U7 — every successful transition appends exactly one status-history row', () => {
  it('records opened/assigned/resolved/reopened in order with the acting actor', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);
    await resolveTicket(db, ticket.ticketId, admin, 'Answered.', new FakePushAdapter());
    await reopenTicket(db, ticket.ticketId, member.member_id, new Date());

    expect(await actionsOf(db, ticket.ticketId)).toEqual([
      { action: 'opened', actor_id: member.member_id },
      { action: 'assigned', actor_id: admin },
      { action: 'resolved', actor_id: admin },
      { action: 'reopened', actor_id: member.member_id },
    ]);
  });

  it('records the withdrawal with the member as actor', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    await withdrawTicket(db, ticket.ticketId, member.member_id);

    expect(await actionsOf(db, ticket.ticketId)).toEqual([
      { action: 'opened', actor_id: member.member_id },
      { action: 'withdrawn', actor_id: member.member_id },
    ]);
  });

  it('appends nothing when a transition is rejected', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    // resolve straight from `open` — pickup is the only path into resolve.
    await expect(resolveTicket(db, ticket.ticketId, admin, 'note', new FakePushAdapter())).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await actionsOf(db, ticket.ticketId)).toEqual([{ action: 'opened', actor_id: member.member_id }]);
  });

  it('stores the resolution note on the resolved history row', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const admin = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, admin);

    await resolveTicket(db, ticket.ticketId, admin, 'Answered by phone.', new FakePushAdapter());

    const row = await db.queryOne<{ notes: string | null }>(
      sql`SELECT notes FROM ticket_actions WHERE ticket_id = ${ticket.ticketId} AND action = 'resolved'`,
    );
    expect(row!.notes).toBe('Answered by phone.');
  });
});
