// STR-081: E09's genesis story -- vendors and work orders, sitting between
// the `vendors`/`work_orders`/`work_order_events` tables
// (migrations/026_vendors_work_orders.sql) and any future HTTP layer (this
// story ships no routes) -- kept testable with a plain Database, no HTTP
// dispatch required (test/vendors/work-orders.test.ts). Mirrors
// members-api.ts's/assets-api.ts's split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { formatMoney, parseMoney } from '../money';

export type WorkOrderStatus = 'issued' | 'in_progress' | 'completed' | 'cancelled';

/** Domain rejection for a create/amend carrying an invalid attribute (e.g. a
 * nonexistent vendor_id). Nothing is written when this is thrown. */
export class WorkOrderValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkOrderValidationError';
  }
}

/** Domain rejection for an amend/cancel attempted from a state that no
 * longer permits it (an invoice already exists, or the work order is
 * already cancelled/unknown). Nothing is written when this is thrown. */
export class WorkOrderConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkOrderConflictError';
  }
}

/** This story's minimal vendor shape -- no CRUD beyond createVendor is in
 * scope (vendor management is a later, unstoried epic concern). */
export interface Vendor {
  id: string;
  name: string;
  gstin: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface CreateVendorInput {
  name: string;
  gstin?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

interface VendorRow {
  id: string;
  name: string;
  gstin: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    name: row.name,
    gstin: row.gstin,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
  };
}

/** Creates a vendor -- the minimal write createWorkOrder's `vendor_id` FK
 * needs. No update/list beyond what tests need; vendor management CRUD is
 * out of this story's scope. */
export async function createVendor(db: Database, input: CreateVendorInput): Promise<Vendor> {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new WorkOrderValidationError('name is required.');
  }

  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO vendors (id, name, gstin, contact_name, email, phone, address)
        VALUES (${id}, ${input.name}, ${input.gstin ?? null}, ${input.contactName ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.address ?? null})`,
  );
  const row = await db.queryOne<VendorRow>(sql`SELECT * FROM vendors WHERE id = ${id}`);
  return toVendor(row!);
}

/** The Vendor Workflow spec's decided Work Order shape -- `value` is always
 * a decimal string via formatMoney, never a raw DB numeric. */
export interface WorkOrder {
  id: string;
  vendorId: string;
  scope: string;
  value: string;
  status: WorkOrderStatus;
  issuedOn: string;
  validUntil: string | null;
  notes: string | null;
}

interface WorkOrderRow {
  id: string;
  vendor_id: string;
  scope: string;
  value: string;
  status: WorkOrderStatus;
  issued_on: string | Date;
  valid_until: string | Date | null;
  notes: string | null;
}

function toDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function toWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    scope: row.scope,
    value: formatMoney(parseMoney(row.value)),
    status: row.status,
    issuedOn: toDateOnly(row.issued_on),
    validUntil: row.valid_until === null ? null : toDateOnly(row.valid_until),
    notes: row.notes,
  };
}

export interface CreateWorkOrderInput {
  vendorId: string;
  scope: string;
  value: string;
  issuedOn: string;
  validUntil?: string | null;
  notes?: string | null;
  actorId?: string | null;
}

/**
 * Issues a new work order against an existing vendor (AC4: a work order can
 * never reference a nonexistent vendor). The vendor-existence check runs
 * before any transaction is opened -- vendors aren't concurrently deleted
 * anywhere in this system, so there's no TOCTOU concern here worth guarding
 * against, unlike amendWorkOrder/cancelWorkOrder below. The insert and its
 * `issued` event share one transaction, so a failure in either leaves
 * nothing written.
 */
export async function createWorkOrder(db: Database, input: CreateWorkOrderInput): Promise<WorkOrder> {
  const vendor = await db.queryOne(sql`SELECT id FROM vendors WHERE id = ${input.vendorId}`);
  if (!vendor) {
    throw new WorkOrderValidationError(`No vendor ${input.vendorId}.`);
  }

  const id = randomUUID();
  const value = formatMoney(parseMoney(input.value));
  await db.transaction(async tx => {
    await tx.execute(
      sql`INSERT INTO work_orders (id, vendor_id, scope, value, status, issued_on, valid_until, notes)
          VALUES (${id}, ${input.vendorId}, ${input.scope}, ${value}::numeric, 'issued', ${input.issuedOn}::date, ${input.validUntil ?? null}::date, ${input.notes ?? null})`,
    );
    await tx.execute(
      sql`INSERT INTO work_order_events (id, work_order_id, action, actor_id, notes)
          VALUES (${randomUUID()}, ${id}, 'issued', ${input.actorId ?? null}, ${null})`,
    );
  });

  const workOrder = await getWorkOrder(db, id);
  return workOrder!;
}

/** A single work order, or `null` if it doesn't exist. */
export async function getWorkOrder(db: Database, workOrderId: string): Promise<WorkOrder | null> {
  const row = await db.queryOne<WorkOrderRow>(sql`SELECT * FROM work_orders WHERE id = ${workOrderId}`);
  return row ? toWorkOrder(row) : null;
}

/** Every work order. No filtering/pagination -- not asked for by this story. */
export async function listWorkOrders(db: Database): Promise<WorkOrder[]> {
  const rows = await db.query<WorkOrderRow>(sql`SELECT * FROM work_orders ORDER BY id`);
  return rows.map(toWorkOrder);
}

export interface AmendWorkOrderPatch {
  scope?: string;
  value?: string;
  validUntil?: string | null;
  notes?: string | null;
}

/**
 * `PATCH /work-orders/{id}` business logic (Vendor Workflow spec: scope/
 * value/validity may be amended only until the first invoice is submitted;
 * 409 after). Unlike cancelWorkOrder's self-referential guard below (whose
 * `WHERE status IN (...)` condition is on the very row the UPDATE locks --
 * genuinely race-free via ordinary Postgres row-lock semantics), the guard
 * here is a CROSS-TABLE check: "no invoice exists for this work order yet."
 * A plain `UPDATE ... WHERE id = ... AND NOT EXISTS (SELECT 1 FROM invoices
 * ...)` does NOT close this race -- an ordinary UPDATE only takes a `FOR NO
 * KEY UPDATE` lock on the work_orders row, which does not conflict with the
 * `FOR KEY SHARE` lock a concurrent `INSERT INTO invoices` takes to satisfy
 * its FK reference (Postgres added FOR KEY SHARE specifically so
 * FK-referencing inserts don't block ordinary updates to the parent row).
 * So a concurrent first-invoice submission could commit invisibly between
 * this function's guard check and its own commit, letting an amendment
 * through after an invoice already exists -- violating AC2/TC-VEN-002.
 *
 * Fixed by taking an explicit `SELECT ... FOR UPDATE` lock on the work_orders
 * row FIRST: FOR UPDATE *does* conflict with FOR KEY SHARE, so a concurrent
 * invoice insert's FK check blocks until this transaction commits or rolls
 * back, and vice versa -- whichever transaction started first is the one
 * whose view of "does an invoice exist" is authoritative. Once the lock is
 * held, the invoice-existence check and the UPDATE are safe to do as two
 * separate statements (no other transaction can interleave). This repo's
 * local test suite runs against `@aws-blocks/bb-data`'s single-connection
 * PGlite mock, which -- like STR-071's own documented gap for
 * allocateReceiptSeriesNumber -- can't exercise true concurrent blocking, so
 * this fix is unverified by any test here; it is a production (real
 * Postgres/Aurora) correctness fix, not a locally-provable one.
 */
export async function amendWorkOrder(db: Database, workOrderId: string, patch: AmendWorkOrderPatch, actorId?: string | null): Promise<WorkOrder> {
  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ id: string }>(sql`SELECT id FROM work_orders WHERE id = ${workOrderId} FOR UPDATE`);
    if (!locked) {
      throw new WorkOrderConflictError(`Work order ${workOrderId} does not exist.`);
    }
    const invoiceExists = await tx.queryOne(sql`SELECT 1 FROM invoices WHERE work_order_id = ${workOrderId}`);
    if (invoiceExists) {
      throw new WorkOrderConflictError(`Work order ${workOrderId} cannot be amended: an invoice has already been submitted against it.`);
    }
    await tx.execute(
      sql`UPDATE work_orders SET
            scope = COALESCE(${patch.scope ?? null}, scope),
            value = COALESCE(${patch.value ? formatMoney(parseMoney(patch.value)) : null}::numeric, value),
            valid_until = COALESCE(${patch.validUntil ?? null}::date, valid_until),
            notes = COALESCE(${patch.notes ?? null}, notes),
            updated_at = now()
          WHERE id = ${workOrderId}`,
    );
    await tx.execute(
      sql`INSERT INTO work_order_events (id, work_order_id, action, actor_id, notes)
          VALUES (${randomUUID()}, ${workOrderId}, 'amended', ${actorId ?? null}, ${null})`,
    );
  });

  return (await getWorkOrder(db, workOrderId))!;
}

/**
 * `POST /work-orders/{id}/cancel` business logic (AC3: cancel works from
 * `issued`/`in_progress`; an already-cancelled work order cannot be
 * cancelled again). Same guarded-UPDATE-with-rowCount-check idiom as
 * amendWorkOrder -- `rowCount === 0` covers both "already cancelled" (the
 * tested case) and an unknown work order id (untested).
 */
export async function cancelWorkOrder(db: Database, workOrderId: string, actorId?: string | null): Promise<WorkOrder> {
  await db.transaction(async tx => {
    const { rowCount } = await tx.execute(
      sql`UPDATE work_orders SET status = 'cancelled', updated_at = now() WHERE id = ${workOrderId} AND status IN ('issued', 'in_progress')`,
    );
    if (rowCount === 0) {
      throw new WorkOrderConflictError(`Work order ${workOrderId} cannot be cancelled (unknown, or already cancelled).`);
    }
    await tx.execute(
      sql`INSERT INTO work_order_events (id, work_order_id, action, actor_id, notes)
          VALUES (${randomUUID()}, ${workOrderId}, 'cancelled', ${actorId ?? null}, ${null})`,
    );
  });

  return (await getWorkOrder(db, workOrderId))!;
}

/**
 * The internal `issued -> in_progress` transition STR-082 fires the moment a
 * work order's first invoice is submitted, from inside STR-082's own
 * invoice-submission transaction -- takes the caller's own Transaction, not
 * a Database, mirroring finance/receipts.ts's allocateReceiptSeriesNumber.
 * No `work_order_events` row is written here: the append-only event table's
 * `action` enum only has issued/amended/cancelled, deliberately no fourth
 * value for this automatic internal transition. This makes idempotency
 * trivial -- the first call flips issued -> in_progress (rowCount 1); every
 * subsequent call (e.g. a work order's second invoice) matches no row
 * (rowCount 0) and is silently a no-op, unlike amendWorkOrder/
 * cancelWorkOrder, which throw on rowCount 0.
 */
export async function advanceWorkOrderToInProgress(tx: Transaction, workOrderId: string): Promise<void> {
  await tx.execute(sql`UPDATE work_orders SET status = 'in_progress', updated_at = now() WHERE id = ${workOrderId} AND status = 'issued'`);
}
