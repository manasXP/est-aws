import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import {
  raiseTicket,
  getTicketRouting,
  replaceTicketRouting,
  TicketValidationError,
} from '../../aws-blocks/tickets/tickets';

// STR-121 — ticket entity, creation, and category routing, unit cases.
// Follows the repo test pattern: fresh Database + Scope per test, all
// migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-121-test-${randomUUID()}`), 'db');
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

/** An employee WITH an admin account (non-empty capabilities — STR-042's
 * designated-account flag, the same check asset-view-grants gates on). */
async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Admin ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

async function plainEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Plain ${randomUUID()}` });
  return employee.employee_id;
}

async function fullRouting(db: Database): Promise<Record<string, string>> {
  return {
    finance: await adminEmployee(db),
    maintenance: await adminEmployee(db),
    records: await adminEmployee(db),
    general: await adminEmployee(db),
  };
}

describe('STR-121 T-U1 — routing configuration round-trips per category', () => {
  it('PUT persists a default assignee for all four categories and GET returns exactly what was set', async () => {
    const db = await freshMigratedDb();
    const routing = await fullRouting(db);

    await replaceTicketRouting(db, routing);

    expect(await getTicketRouting(db)).toEqual(routing);
  });

  it('a second PUT replaces the whole configuration', async () => {
    const db = await freshMigratedDb();
    await replaceTicketRouting(db, await fullRouting(db));
    const second = await fullRouting(db);

    await replaceTicketRouting(db, second);

    expect(await getTicketRouting(db)).toEqual(second);
  });
});

describe('STR-121 T-U2 — routing rejects assignees without an admin account, all-or-nothing', () => {
  it('fails 422 and writes nothing when one of four assignees has no admin account', async () => {
    const db = await freshMigratedDb();
    const routing = await fullRouting(db);
    routing.records = await plainEmployee(db);

    await expect(replaceTicketRouting(db, routing)).rejects.toBeInstanceOf(TicketValidationError);

    const rows = await db.query(sql`SELECT category FROM ticket_routing`);
    expect(rows).toEqual([]);
  });

  it('fails 422 when a category key is missing entirely', async () => {
    const db = await freshMigratedDb();
    const routing = await fullRouting(db);
    delete (routing as Record<string, unknown>).general;

    await expect(replaceTicketRouting(db, routing)).rejects.toBeInstanceOf(TicketValidationError);
  });
});

describe('STR-121 T-U3 — an unrouted category opens tickets with a null assignee', () => {
  it('raises the ticket open with assignee null instead of failing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });

    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift is stuck on 3.');

    expect(ticket.status).toBe('open');
    const row = await db.queryOne<{ assignee_id: string | null }>(
      sql`SELECT assignee_id FROM tickets WHERE id = ${ticket.ticketId}`,
    );
    expect(row).toEqual({ assignee_id: null });
  });

  it('routes to the configured assignee when the category IS routed', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const routing = await fullRouting(db);
    await replaceTicketRouting(db, routing);

    const ticket = await raiseTicket(db, member.member_id, 'finance', 'Wrong charge', 'July maintenance billed twice.');

    const row = await db.queryOne<{ assignee_id: string | null }>(
      sql`SELECT assignee_id FROM tickets WHERE id = ${ticket.ticketId}`,
    );
    expect(row).toEqual({ assignee_id: routing.finance });
  });

  it('rejects an unknown category, writing nothing', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });

    await expect(raiseTicket(db, member.member_id, 'plumbing', 'x', 'y')).rejects.toBeInstanceOf(TicketValidationError);

    expect(await db.query(sql`SELECT id FROM tickets`)).toEqual([]);
  });
});

describe('STR-121 T-U4 — raised_by is the member, entered_by stays null on this surface', () => {
  it('records member_id as raised_by and leaves entered_by null', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });

    const ticket = await raiseTicket(db, member.member_id, 'records', 'Share certificate copy', 'Need a certified copy.');

    const row = await db.queryOne<{ member_id: string; entered_by: string | null }>(
      sql`SELECT member_id, entered_by FROM tickets WHERE id = ${ticket.ticketId}`,
    );
    expect(row).toEqual({ member_id: member.member_id, entered_by: null });
  });
});
