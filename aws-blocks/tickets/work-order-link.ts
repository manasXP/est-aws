// STR-125: the informational work-order link (Member Requests spec,
// Routing). Deliberately not part of lifecycle.ts: this is the one ticket
// write that is *not* a transition. It touches exactly one column and no
// lifecycle field, appends no ticket_actions row, and -- the spec's
// emphasis -- leaves the work-order -> invoice -> approval money path
// entirely alone. Nothing in E09 reads this column.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { TicketValidationError, toTicket } from './tickets';
import type { TicketRecord, TicketRow } from './tickets';
import { TicketLifecycleConflictError } from './lifecycle';

/**
 * Admin `PUT /v1/tickets/{ticketId}/work-order` (TC-TKT-024, AC3/AC4): sets
 * or (with `null`) clears the link. Returns `null` for an unknown ticket --
 * the OpenAPI's 404.
 *
 * Maintenance tickets only (409 otherwise), and no status guard beyond
 * that: the link is independent of the ticket's own lifecycle in both
 * directions, so it can be set or cleared whatever state the ticket is in.
 * `updated_at` is left alone too -- AC3 counts timestamps among the fields a
 * link write must not move.
 */
export async function setTicketWorkOrder(
  db: Database,
  ticketId: string,
  workOrderId: string | null,
): Promise<TicketRecord | null> {
  return db.transaction(async tx => {
    const row = await tx.queryOne<TicketRow>(sql`SELECT * FROM tickets WHERE id = ${ticketId} FOR UPDATE`);
    if (!row) return null;
    if (row.category !== 'maintenance') {
      throw new TicketLifecycleConflictError(
        `Ticket ${ticketId} is a ${row.category} ticket; work-order links are maintenance-only.`,
      );
    }

    if (workOrderId !== null) {
      const workOrder = await tx.queryOne(sql`SELECT id FROM work_orders WHERE id = ${workOrderId}`);
      if (!workOrder) {
        throw new TicketValidationError(`No work order ${workOrderId}.`);
      }
    }

    const updated = await tx.queryOne<TicketRow>(
      sql`UPDATE tickets SET work_order_id = ${workOrderId} WHERE id = ${ticketId} RETURNING *`,
    );
    return toTicket(updated!);
  });
}
