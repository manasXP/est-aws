import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { raiseTicket } from '../../aws-blocks/tickets/tickets';
import { setTicketWorkOrder } from '../../aws-blocks/tickets/work-order-link';
import { pickupTicket } from '../../aws-blocks/tickets/lifecycle';
import { addComment } from '../../aws-blocks/tickets/comments';
import {
  listTicketsForTriage,
  getTicketDetail,
  listTicketsForMember,
  getTicketDetailForMember,
} from '../../aws-blocks/tickets/queries';
import type { PushAdapter } from '../../aws-blocks/notifications/push-adapter';

// STR-126 — the read surfaces over everything E13 already writes. Every
// case here is a *read*: the Definition of Done requires that no path in
// this diff writes to any ticket table, so the assertions below check the
// rows are untouched as much as they check what comes back.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-126-test-${randomUUID()}`), 'db');
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

const noopPush: PushAdapter = { send: async () => {} };

async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Admin ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

/** Back-dates a ticket's creation so age is deterministic without a clock. */
async function backdate(db: Database, ticketId: string, daysAgo: number): Promise<void> {
  await db.execute(
    sql`UPDATE tickets SET created_at = now() - ${`${daysAgo} days`}::interval WHERE id = ${ticketId}`,
  );
}

async function allTicketRows(db: Database): Promise<unknown[]> {
  return db.query(sql`SELECT * FROM tickets ORDER BY id`);
}

describe('STR-126 T-U1 — the queue is an ageing view with no escalation side effects (covers TC-TKT-025)', () => {
  it('returns tickets oldest-first with a computed age, leaving every row untouched', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const newest = await raiseTicket(db, member.member_id, 'general', 'Newest', 'x');
    const oldest = await raiseTicket(db, member.member_id, 'general', 'Oldest', 'x');
    const middle = await raiseTicket(db, member.member_id, 'general', 'Middle', 'x');
    await backdate(db, oldest.ticketId, 30);
    await backdate(db, middle.ticketId, 10);
    const before = await allTicketRows(db);

    const queue = await listTicketsForTriage(db, {});

    expect(queue.map(t => t.ticketId)).toEqual([oldest.ticketId, middle.ticketId, newest.ticketId]);
    expect(queue[0].ageDays).toBe(30);
    expect(queue[1].ageDays).toBe(10);
    expect(queue[2].ageDays).toBe(0);
    expect(await allTicketRows(db)).toEqual(before);
  });

  it('does not escalate: a 90-day-old open ticket is still open, unassigned, after being listed', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Ancient', 'x');
    await backdate(db, ticket.ticketId, 90);

    const [listed] = await listTicketsForTriage(db, {});

    expect(listed.ageDays).toBe(90);
    expect(listed.status).toBe('open');
    const row = await db.queryOne<{ status: string; assignee_id: string | null }>(
      sql`SELECT status, assignee_id FROM tickets WHERE id = ${ticket.ticketId}`,
    );
    expect(row).toEqual({ status: 'open', assignee_id: null });
    expect(await db.query(sql`SELECT id FROM ticket_actions WHERE action != 'opened'`)).toEqual([]);
  });
});

describe('STR-126 AC1 — the queue filters on every documented parameter, alone and combined', () => {
  async function seedQueue(db: Database) {
    const asha = await createMember(db, { name: 'Asha Rao' });
    const bimal = await createMember(db, { name: 'Bimal Sen' });
    const staff = await adminEmployee(db);

    const ashaFinance = await raiseTicket(db, asha.member_id, 'finance', 'Asha finance', 'x');
    const ashaMaint = await raiseTicket(db, asha.member_id, 'maintenance', 'Asha maintenance', 'x');
    const bimalFinance = await raiseTicket(db, bimal.member_id, 'finance', 'Bimal finance', 'x');
    // Assignment moves this one to in_progress and onto `staff`.
    await pickupTicket(db, bimalFinance.ticketId, staff, staff);

    return { asha, bimal, staff, ashaFinance, ashaMaint, bimalFinance };
  }

  it('filters by category', async () => {
    const db = await freshMigratedDb();
    const { ashaMaint } = await seedQueue(db);

    const queue = await listTicketsForTriage(db, { category: 'maintenance' });

    expect(queue.map(t => t.ticketId)).toEqual([ashaMaint.ticketId]);
  });

  it('filters by status', async () => {
    const db = await freshMigratedDb();
    const { bimalFinance } = await seedQueue(db);

    const queue = await listTicketsForTriage(db, { status: 'in_progress' });

    expect(queue.map(t => t.ticketId)).toEqual([bimalFinance.ticketId]);
  });

  it('filters by assignee', async () => {
    const db = await freshMigratedDb();
    const { staff, bimalFinance } = await seedQueue(db);

    const queue = await listTicketsForTriage(db, { assigneeId: staff });

    expect(queue.map(t => t.ticketId)).toEqual([bimalFinance.ticketId]);
  });

  it('filters by member', async () => {
    const db = await freshMigratedDb();
    const { asha, ashaFinance, ashaMaint } = await seedQueue(db);

    const queue = await listTicketsForTriage(db, { memberId: asha.member_id });

    expect(new Set(queue.map(t => t.ticketId))).toEqual(new Set([ashaFinance.ticketId, ashaMaint.ticketId]));
  });

  it('combines filters conjunctively', async () => {
    const db = await freshMigratedDb();
    const { asha, ashaFinance } = await seedQueue(db);

    const queue = await listTicketsForTriage(db, {
      memberId: asha.member_id,
      category: 'finance',
      status: 'open',
    });

    expect(queue.map(t => t.ticketId)).toEqual([ashaFinance.ticketId]);

    // A combination matching nothing returns empty, not everything.
    expect(await listTicketsForTriage(db, { memberId: asha.member_id, category: 'finance', status: 'resolved' }))
      .toEqual([]);
  });
});

describe('STR-126 T-U2 — ticket detail assembles thread, attachments, actions, and the work-order link', () => {
  it('joins every related table into one response', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift on 3.');
    await addComment(db, noopPush, ticket.ticketId, 'member', member.member_id, 'Still stuck.');
    await addComment(db, noopPush, ticket.ticketId, 'staff', staff, 'Vendor called.');
    await db.execute(
      sql`INSERT INTO ticket_attachments (id, ticket_id, file_name, mime_type, object_path)
          VALUES (${randomUUID()}, ${ticket.ticketId}, 'lift.jpg', 'image/jpeg', ${`tickets/${ticket.ticketId}/lift.jpg`})`,
    );
    await pickupTicket(db, ticket.ticketId, staff, staff);
    const vendor = await createVendor(db, { name: `Vendor ${randomUUID()}` });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Lift repair',
      value: '12500.00',
      issuedOn: '2026-07-01',
    });
    await setTicketWorkOrder(db, ticket.ticketId, workOrder.id);

    const detail = await getTicketDetail(db, ticket.ticketId);

    expect(detail!.ticketId).toBe(ticket.ticketId);
    expect(detail!.workOrderId).toBe(workOrder.id);
    expect(detail!.comments.map(c => c.body)).toEqual(['Still stuck.', 'Vendor called.']);
    expect(detail!.attachments.map(a => a.fileName)).toEqual(['lift.jpg']);
    expect(detail!.actions.map(a => a.action)).toEqual(['opened', 'assigned']);
  });

  it('returns null for an unknown ticket', async () => {
    const db = await freshMigratedDb();

    expect(await getTicketDetail(db, 'no-such-ticket')).toBeNull();
  });

  it('returns empty collections for a ticket with no thread, attachments, or link', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'records', 'Copy please', 'x');

    const detail = await getTicketDetail(db, ticket.ticketId);

    expect(detail!.comments).toEqual([]);
    expect(detail!.attachments).toEqual([]);
    expect(detail!.workOrderId).toBeNull();
    expect(detail!.actions.map(a => a.action)).toEqual(['opened']);
  });
});

describe('STR-126 T-U3 — a member reads only their own tickets (AC4)', () => {
  it('lists only the calling member’s tickets, whatever other members hold', async () => {
    const db = await freshMigratedDb();
    const asha = await createMember(db, { name: 'Asha Rao' });
    const bimal = await createMember(db, { name: 'Bimal Sen' });
    const mine = await raiseTicket(db, asha.member_id, 'finance', 'Mine', 'x');
    await raiseTicket(db, bimal.member_id, 'finance', 'Theirs', 'x');

    const listed = await listTicketsForMember(db, asha.member_id);

    expect(listed.map(t => t.ticketId)).toEqual([mine.ticketId]);
  });

  it('honors the status filter and defaults to every status', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const open = await raiseTicket(db, member.member_id, 'finance', 'Open one', 'x');
    const inProgress = await raiseTicket(db, member.member_id, 'general', 'Picked up', 'x');
    await pickupTicket(db, inProgress.ticketId, staff, staff);

    expect((await listTicketsForMember(db, member.member_id, 'open')).map(t => t.ticketId)).toEqual([open.ticketId]);
    expect((await listTicketsForMember(db, member.member_id, 'in_progress')).map(t => t.ticketId))
      .toEqual([inProgress.ticketId]);
    expect(new Set((await listTicketsForMember(db, member.member_id)).map(t => t.ticketId)))
      .toEqual(new Set([open.ticketId, inProgress.ticketId]));
  });

  it('refuses detail on another member’s ticket, revealing nothing about it', async () => {
    const db = await freshMigratedDb();
    const asha = await createMember(db, { name: 'Asha Rao' });
    const bimal = await createMember(db, { name: 'Bimal Sen' });
    const theirs = await raiseTicket(db, bimal.member_id, 'records', 'Private matter', 'x');
    await addComment(db, noopPush, theirs.ticketId, 'member', bimal.member_id, 'Sensitive.');

    expect(await getTicketDetailForMember(db, theirs.ticketId, asha.member_id)).toBeNull();
    // The owner still reads it — the guard is ownership, not a broken join.
    expect((await getTicketDetailForMember(db, theirs.ticketId, bimal.member_id))!.comments).toHaveLength(1);
  });
});
