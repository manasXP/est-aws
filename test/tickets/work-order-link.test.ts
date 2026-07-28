import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { raiseTicket, TicketValidationError } from '../../aws-blocks/tickets/tickets';
import { TicketLifecycleConflictError } from '../../aws-blocks/tickets/lifecycle';
import { setTicketWorkOrder } from '../../aws-blocks/tickets/work-order-link';

// STR-125 — the informational work-order link, unit cases. The link is
// deliberately inert: it never touches a lifecycle field, and no lifecycle
// transition touches it. Every case here reads the whole row before and
// after and asserts the *rest* of it is byte-identical.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-125-work-order-test-${randomUUID()}`), 'db');
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

async function aWorkOrder(db: Database): Promise<string> {
  const vendor = await createVendor(db, { name: `Vendor ${randomUUID()}` });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Lift repair',
    value: '12500.00',
    issuedOn: '2026-07-01',
  });
  return workOrder.id;
}

type TicketRowSnapshot = Record<string, unknown>;

async function snapshot(db: Database, ticketId: string): Promise<TicketRowSnapshot> {
  const row = await db.queryOne<TicketRowSnapshot>(sql`SELECT * FROM tickets WHERE id = ${ticketId}`);
  return row!;
}

/** Everything except the link itself — what a link write must never move. */
function withoutLink(row: TicketRowSnapshot): TicketRowSnapshot {
  const { work_order_id: _link, ...rest } = row;
  return rest;
}

describe('STR-125 T-U3 — linking is maintenance-only and touches nothing else (covers TC-TKT-024)', () => {
  it('sets work_order_id on a maintenance ticket with no change to any other field', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift on 3.');
    const workOrderId = await aWorkOrder(db);
    const before = await snapshot(db, ticket.ticketId);

    const linked = await setTicketWorkOrder(db, ticket.ticketId, workOrderId);

    expect(linked?.workOrderId).toBe(workOrderId);
    expect(linked?.status).toBe('open');
    expect(linked?.resolutionNote).toBeNull();
    const after = await snapshot(db, ticket.ticketId);
    expect(after.work_order_id).toBe(workOrderId);
    expect(withoutLink(after)).toEqual(withoutLink(before));
  });

  it.each(['finance', 'records', 'general'])('rejects the link on a %s ticket, setting nothing', async category => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, category, 'Query', 'Details.');
    const workOrderId = await aWorkOrder(db);
    const before = await snapshot(db, ticket.ticketId);

    await expect(setTicketWorkOrder(db, ticket.ticketId, workOrderId)).rejects.toBeInstanceOf(
      TicketLifecycleConflictError,
    );

    expect(await snapshot(db, ticket.ticketId)).toEqual(before);
  });

  it('leaves a resolved ticket resolved, with its resolution note intact', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift on 3.');
    await db.execute(
      sql`UPDATE tickets SET status = 'resolved', resolution_note = 'Vendor attended.', resolved_at = now()
          WHERE id = ${ticket.ticketId}`,
    );
    const before = await snapshot(db, ticket.ticketId);

    await setTicketWorkOrder(db, ticket.ticketId, await aWorkOrder(db));

    expect(withoutLink(await snapshot(db, ticket.ticketId))).toEqual(withoutLink(before));
  });
});

describe('STR-125 T-U4 — the link can be cleared and re-set independently', () => {
  it('clears the link with a null id, touching no other field, and re-links afterward', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift on 3.');
    const first = await aWorkOrder(db);
    await setTicketWorkOrder(db, ticket.ticketId, first);
    const linked = await snapshot(db, ticket.ticketId);

    const cleared = await setTicketWorkOrder(db, ticket.ticketId, null);

    expect(cleared?.workOrderId).toBeNull();
    expect(withoutLink(await snapshot(db, ticket.ticketId))).toEqual(withoutLink(linked));

    const second = await aWorkOrder(db);
    const relinked = await setTicketWorkOrder(db, ticket.ticketId, second);
    expect(relinked?.workOrderId).toBe(second);
  });

  it('reports an unknown ticket rather than writing anything', async () => {
    const db = await freshMigratedDb();

    expect(await setTicketWorkOrder(db, 'no-such-ticket', await aWorkOrder(db))).toBeNull();
  });

  // E09's work_orders table is already in place (STR-081), so the story's
  // "opportunistic if present" existence check is a real one here — see this
  // story's PR body.
  it('rejects an unknown work order, leaving the ticket unlinked', async () => {
    const db = await freshMigratedDb();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Lift stuck', 'B-wing lift on 3.');

    await expect(setTicketWorkOrder(db, ticket.ticketId, 'no-such-work-order')).rejects.toBeInstanceOf(
      TicketValidationError,
    );

    expect((await snapshot(db, ticket.ticketId)).work_order_id).toBeNull();
  });
});
