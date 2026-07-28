import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { raiseTicket, replaceTicketRouting, TicketValidationError } from '../../aws-blocks/tickets/tickets';

// STR-125 — on-behalf ticket entry (walk-in/phone), unit cases. Same
// creation core as STR-121's member-raised path with one extra field, so
// these assert the *sameness* (routing, status) as much as the difference
// (entered_by).

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-125-on-behalf-test-${randomUUID()}`), 'db');
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

async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Admin ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
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

describe('STR-125 T-U1 — on-behalf entry records entered_by, ownership stays with the member (covers TC-TKT-023)', () => {
  it('records the acting admin as entered_by while the ticket belongs to the named member', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);

    const ticket = await raiseTicket(db, member.member_id, 'records', 'Share certificate copy', 'Walked in.', staff);

    expect(ticket.memberId).toBe(member.member_id);
    expect(ticket.enteredBy).toBe(staff);
    const row = await db.queryOne<{ member_id: string; entered_by: string | null }>(
      sql`SELECT member_id, entered_by FROM tickets WHERE id = ${ticket.ticketId}`,
    );
    expect(row).toEqual({ member_id: member.member_id, entered_by: staff });
  });

  it('opens the ticket open and routed exactly as a self-raised ticket of the same category', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const routing = await fullRouting(db);
    await replaceTicketRouting(db, routing);
    const staff = await adminEmployee(db);

    const selfRaised = await raiseTicket(db, member.member_id, 'finance', 'Wrong charge', 'Billed twice.');
    const onBehalf = await raiseTicket(db, member.member_id, 'finance', 'Wrong charge', 'Phoned in.', staff);

    expect(onBehalf.status).toBe('open');
    expect(onBehalf.assigneeId).toBe(routing.finance);
    expect(onBehalf.assigneeId).toBe(selfRaised.assigneeId);
    expect(onBehalf.status).toBe(selfRaised.status);
  });

  it('leaves entered_by null when no acting admin is given (the member-raised path is unchanged)', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });

    const ticket = await raiseTicket(db, member.member_id, 'general', 'Gate light', 'Out since Monday.');

    expect(ticket.enteredBy).toBeNull();
  });
});

describe('STR-125 T-U2 — on-behalf entry naming a nonexistent member fails cleanly', () => {
  it('rejects the unknown member and writes no ticket', async () => {
    const db = await freshMigratedDb();
    const staff = await adminEmployee(db);

    await expect(
      raiseTicket(db, 'no-such-member', 'maintenance', 'Lift stuck', 'Reported at the desk.', staff),
    ).rejects.toBeInstanceOf(TicketValidationError);

    expect(await db.query(sql`SELECT id FROM tickets`)).toEqual([]);
    expect(await db.query(sql`SELECT id FROM ticket_actions`)).toEqual([]);
  });
});
