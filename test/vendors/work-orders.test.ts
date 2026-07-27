import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import {
  createVendor,
  createWorkOrder,
  amendWorkOrder,
  cancelWorkOrder,
  advanceWorkOrderToInProgress,
  getWorkOrder,
  WorkOrderValidationError,
  WorkOrderConflictError,
} from '../../aws-blocks/vendors/work-orders';

// STR-081 -- work order entity and state machine, unit cases. Follows the
// STR-031 test pattern (test/members/members-api.test.ts): fresh Database +
// Scope per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-081-work-orders-test-${randomUUID()}`), 'db');
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

describe('STR-081 T-U1 (TC-VEN-001) — amending an issued work order with no invoices', () => {
  it('succeeds, reflects the new values, and records an amended event', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe in block A',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });

    const amended = await amendWorkOrder(db, workOrder.id, {
      scope: 'Fix leaking pipe in block A and block B',
      value: '7500.00',
      validUntil: '2026-12-31',
      notes: 'Scope widened after site visit.',
    });

    expect(amended.scope).toBe('Fix leaking pipe in block A and block B');
    expect(amended.value).toBe('7500.00');
    expect(amended.validUntil).toBe('2026-12-31');
    expect(amended.notes).toBe('Scope widened after site visit.');

    const refetched = await getWorkOrder(db, workOrder.id);
    expect(refetched).toEqual(amended);

    const events = await db.query<{ action: string }>(
      sql`SELECT action FROM work_order_events WHERE work_order_id = ${workOrder.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['issued', 'amended']);
  });
});

describe('STR-081 T-U2 (TC-VEN-002) — amending a work order with a submitted invoice', () => {
  it('throws WorkOrderConflictError and writes nothing', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await db.execute(sql`INSERT INTO invoices (id, work_order_id) VALUES (${randomUUID()}, ${workOrder.id})`);

    await expect(amendWorkOrder(db, workOrder.id, { scope: 'Different scope' })).rejects.toThrow(WorkOrderConflictError);

    const refetched = await getWorkOrder(db, workOrder.id);
    expect(refetched!.scope).toBe('Fix leaking pipe');
  });
});

describe('STR-081 T-U3 — issuing a work order against an unknown vendor_id', () => {
  it('throws WorkOrderValidationError and writes nothing', async () => {
    const db = await freshMigratedDb();

    await expect(
      createWorkOrder(db, {
        vendorId: randomUUID(),
        scope: 'Fix leaking pipe',
        value: '5000.00',
        issuedOn: '2026-07-01',
      }),
    ).rejects.toThrow(WorkOrderValidationError);

    const workOrders = await db.query(sql`SELECT id FROM work_orders`);
    expect(workOrders).toHaveLength(0);
    const events = await db.query(sql`SELECT id FROM work_order_events`);
    expect(events).toHaveLength(0);
  });
});

describe('STR-081 T-U4 (TC cancel) — cancelling a work order', () => {
  it('transitions issued -> cancelled, recording an event', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });

    const cancelled = await cancelWorkOrder(db, workOrder.id);

    expect(cancelled.status).toBe('cancelled');
    const events = await db.query<{ action: string }>(
      sql`SELECT action FROM work_order_events WHERE work_order_id = ${workOrder.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['issued', 'cancelled']);
  });

  it('transitions in_progress -> cancelled, recording an event', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await db.transaction(tx => advanceWorkOrderToInProgress(tx, workOrder.id));

    const cancelled = await cancelWorkOrder(db, workOrder.id);

    expect(cancelled.status).toBe('cancelled');
    const events = await db.query<{ action: string }>(
      sql`SELECT action FROM work_order_events WHERE work_order_id = ${workOrder.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['issued', 'cancelled']);
  });

  it('throws WorkOrderConflictError when cancelling an already-cancelled work order', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });
    await cancelWorkOrder(db, workOrder.id);

    await expect(cancelWorkOrder(db, workOrder.id)).rejects.toThrow(WorkOrderConflictError);
  });
});

describe('STR-081 T-U5 — advanceWorkOrderToInProgress is idempotent', () => {
  it('leaves the work order in_progress after two calls, with no duplicate event written', async () => {
    const db = await freshMigratedDb();
    const vendor = await createVendor(db, { name: 'Acme Plumbing' });
    const workOrder = await createWorkOrder(db, {
      vendorId: vendor.id,
      scope: 'Fix leaking pipe',
      value: '5000.00',
      issuedOn: '2026-07-01',
    });

    const eventsBefore = await db.query(sql`SELECT id FROM work_order_events WHERE work_order_id = ${workOrder.id}`);

    await db.transaction(tx => advanceWorkOrderToInProgress(tx, workOrder.id));
    await db.transaction(tx => advanceWorkOrderToInProgress(tx, workOrder.id));

    const afterFirst = await getWorkOrder(db, workOrder.id);
    expect(afterFirst!.status).toBe('in_progress');

    const eventsAfter = await db.query(sql`SELECT id FROM work_order_events WHERE work_order_id = ${workOrder.id}`);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});
