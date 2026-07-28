// STR-122: the single ticket state-machine surface. Both the admin
// (`/v1/tickets/{id}/assign`, `/resolve`) and mobile
// (`/v1/me/tickets/{id}/reopen`, `/withdraw`) handlers import these
// functions, so neither surface hand-rolls its own status guard -- the
// Risks-section mitigation for lifecycle drift between the two.
//
// The lifecycle, from the Member Requests spec:
//
//   open -> in_progress -> resolved -> closed   (auto-close 7d after resolve)
//   open | in_progress -> withdrawn             (by the raising member)
//   resolved -> open                            (member reopen, inside 7d)
//
// `closed` and `withdrawn` are terminal: no function here accepts either as
// a source status, so no code path mutates a ticket in either state (AC4).
// Every transition takes its row `FOR UPDATE` and writes the tickets UPDATE
// and its ticket_actions row in one transaction (the documents-api.ts
// archiveDocument precedent), so a rejection leaves nothing behind.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ConflictError } from '../http/problem-response';
import { TicketValidationError, toTicket } from './tickets';
import type { TicketRecord, TicketRow, TicketStatus } from './tickets';
import type { PushAdapter, PushNotification } from '../notifications/push-adapter';

/** The auto-close / reopen window, in days -- one constant behind both the
 * CronJob's close decision and reopen's window guard, so they can never
 * disagree (spec: "a resolved ticket closes automatically 7 days after
 * resolution unless the member reopens it; the reopen window is those same
 * 7 days"). */
export const AUTO_CLOSE_DAYS = 7;

const AUTO_CLOSE_WINDOW_MS = AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000;

/** Domain rejection for a transition invalid in the ticket's current state
 * -- including any attempt on a terminal `closed`/`withdrawn` ticket, and a
 * reopen or withdraw by someone other than the raising member. Thrown
 * before any write. Named after documents-api.ts's
 * DocumentLifecycleConflictError precedent. */
export class TicketLifecycleConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'TicketLifecycleConflictError';
  }
}

/**
 * The auto-close decision (AC3, T-P1): pure, total, and clock-injected --
 * `now` is a parameter, never `Date.now()` read inside. This is the epic's
 * named auto-close risk ("a mis-scheduled job silently strands or
 * prematurely closes tickets") reduced to a function that can be pinned at
 * the boundary by test rather than by a live clock.
 *
 * Exactly at `resolved_at + 7d` the ticket closes; one millisecond earlier
 * it does not.
 */
export function isPastAutoCloseWindow(resolvedAt: string | Date, now: Date): boolean {
  const resolved = resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt);
  return now.getTime() - resolved.getTime() >= AUTO_CLOSE_WINDOW_MS;
}

type TicketAction = 'assigned' | 'resolved' | 'reopened' | 'withdrawn' | 'closed';

/** Appends one row to the append-only status-history trail. Always called
 * inside the same transaction as the tickets UPDATE it records. */
async function appendAction(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  ticketId: string,
  action: TicketAction,
  actorId: string,
  notes: string | null = null,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO ticket_actions (id, ticket_id, action, actor_id, notes)
        VALUES (${randomUUID()}, ${ticketId}, ${action}, ${actorId}, ${notes})`,
  );
}

/** The states in which a ticket still accepts writes -- the complement of
 * the terminal pair. STR-123's comment thread guards on exactly this set,
 * so "terminal" is defined once for status transitions and thread writes
 * alike. */
export const NON_TERMINAL_TICKET_STATUSES: TicketStatus[] = ['open', 'in_progress', 'resolved'];

/** Loads the ticket under `FOR UPDATE` and rejects unless its status is one
 * of `allowed` -- the single guard every transition below routes through,
 * so `closed`/`withdrawn` are unreachable as a source state everywhere at
 * once. Exported for STR-123, whose comment writes are not transitions but
 * must honour the same terminal rule (the epic Risks section's
 * shared-state-machine mitigation). */
export async function lockInState(
  tx: { queryOne: <T>(query: ReturnType<typeof sql>) => Promise<T | null> },
  ticketId: string,
  allowed: TicketStatus[],
): Promise<TicketRow> {
  const row = await tx.queryOne<TicketRow>(sql`SELECT * FROM tickets WHERE id = ${ticketId} FOR UPDATE`);
  if (!row) {
    throw new TicketLifecycleConflictError(`No ticket ${ticketId}.`);
  }
  if (!allowed.includes(row.status)) {
    throw new TicketLifecycleConflictError(
      `Ticket ${ticketId} is ${row.status}; this action requires ${allowed.join(' or ')}.`,
    );
  }
  return row;
}

/**
 * Admin `POST /v1/tickets/{ticketId}/assign` (TC-TKT-002): picks up an
 * `open` ticket into `in_progress`. With no explicit `assigneeId` the
 * category's *currently* configured default is resolved from
 * `ticket_routing` -- re-read here rather than reusing the creation-time
 * value, so a routing change between raise and pickup takes effect. An
 * explicit `assigneeId` overrides it ("management may reassign any
 * ticket").
 */
export async function pickupTicket(
  db: Database,
  ticketId: string,
  actorId: string,
  assigneeId?: string | null,
): Promise<TicketRecord> {
  return db.transaction(async tx => {
    const row = await lockInState(tx, ticketId, ['open']);

    let assignee = assigneeId ?? null;
    if (assignee === null) {
      const routed = await tx.queryOne<{ assignee_id: string }>(
        sql`SELECT assignee_id FROM ticket_routing WHERE category = ${row.category}`,
      );
      assignee = routed?.assignee_id ?? null;
    }

    const updated = await tx.queryOne<TicketRow>(
      sql`UPDATE tickets SET status = 'in_progress', assignee_id = ${assignee}, updated_at = now()
          WHERE id = ${ticketId} RETURNING *`,
    );
    await appendAction(tx, ticketId, 'assigned', actorId);
    return toTicket(updated!);
  });
}

/**
 * Admin `POST /v1/tickets/{ticketId}/resolve` (TC-TKT-003, AC2): moves an
 * `in_progress` ticket to `resolved`. The `resolution_note` is mandatory --
 * `resolved` is unreachable without one -- and is validated before the
 * transaction opens, so a noteless call writes nothing.
 *
 * Dispatches one push per the member's registered devices through the
 * STR-067 `PushAdapter` interface (AC5); no push-provider SDK type appears
 * here. The dispatch runs after the transaction commits, so a push
 * provider failure cannot roll back a recorded resolution.
 */
export async function resolveTicket(
  db: Database,
  ticketId: string,
  actorId: string,
  resolutionNote: string,
  adapter: PushAdapter,
): Promise<TicketRecord> {
  if (!resolutionNote || typeof resolutionNote !== 'string') {
    throw new TicketValidationError('resolution_note is required to resolve a ticket.');
  }

  const ticket = await db.transaction(async tx => {
    await lockInState(tx, ticketId, ['in_progress']);
    const updated = await tx.queryOne<TicketRow>(
      sql`UPDATE tickets
          SET status = 'resolved', resolution_note = ${resolutionNote}, resolved_at = now(), updated_at = now()
          WHERE id = ${ticketId} RETURNING *`,
    );
    await appendAction(tx, ticketId, 'resolved', actorId, resolutionNote);
    return toTicket(updated!);
  });

  const devices = await db.query<{ push_token: string }>(
    sql`SELECT push_token FROM registered_devices WHERE member_id = ${ticket.memberId}`,
  );
  const notification: PushNotification = {
    title: 'Request resolved',
    body: 'Your request has been resolved -- open the app to review or reopen it.',
  };
  for (const device of devices) {
    await adapter.send(device.push_token, notification);
  }

  return ticket;
}

/**
 * Mobile `POST /v1/me/tickets/{ticketId}/reopen` (TC-TKT-005, AC4): returns
 * a `resolved` ticket to `open` for the member who raised it, inside the
 * 7-day window only.
 *
 * The window is checked against `resolved_at` here rather than relying on
 * the auto-close run having already fired -- the CronJob is daily, so a
 * ticket resolved 8 days ago may still read `resolved` when the member
 * calls. Both guards are needed for AC4's "reopen only succeeds inside the
 * 7-day window" to hold independently of job scheduling.
 */
export async function reopenTicket(
  db: Database,
  ticketId: string,
  memberId: string,
  now: Date,
): Promise<TicketRecord> {
  return db.transaction(async tx => {
    const row = await lockInState(tx, ticketId, ['resolved']);
    if (row.member_id !== memberId) {
      throw new TicketLifecycleConflictError(`Ticket ${ticketId} was not raised by member ${memberId}.`);
    }
    if (row.resolved_at !== null && isPastAutoCloseWindow(row.resolved_at, now)) {
      throw new TicketLifecycleConflictError(
        `Ticket ${ticketId} passed its ${AUTO_CLOSE_DAYS}-day reopen window; raise a new ticket instead.`,
      );
    }

    const updated = await tx.queryOne<TicketRow>(
      sql`UPDATE tickets SET status = 'open', resolved_at = NULL, updated_at = now()
          WHERE id = ${ticketId} RETURNING *`,
    );
    await appendAction(tx, ticketId, 'reopened', memberId);
    return toTicket(updated!);
  });
}

/**
 * Mobile `POST /v1/me/tickets/{ticketId}/withdraw` (TC-TKT-006, AC4):
 * withdraws an `open` or `in_progress` ticket, by the raising member only,
 * before resolution -- so a ticket can never be withdrawn out from under
 * staff who have already resolved it. `withdrawn` is terminal.
 */
export async function withdrawTicket(db: Database, ticketId: string, memberId: string): Promise<TicketRecord> {
  return db.transaction(async tx => {
    const row = await lockInState(tx, ticketId, ['open', 'in_progress']);
    if (row.member_id !== memberId) {
      throw new TicketLifecycleConflictError(`Ticket ${ticketId} was not raised by member ${memberId}.`);
    }

    const updated = await tx.queryOne<TicketRow>(
      sql`UPDATE tickets SET status = 'withdrawn', updated_at = now() WHERE id = ${ticketId} RETURNING *`,
    );
    await appendAction(tx, ticketId, 'withdrawn', memberId);
    return toTicket(updated!);
  });
}

/**
 * The auto-close run's core (TC-TKT-004, AC3) -- the testable body behind
 * the daily `CronJob` registered in aws-blocks/index.ts, which passes its
 * own `scheduledTime` as `now` (the STR-061 charge-run split: no
 * `Date.now()` inside the handler itself).
 *
 * Selects only `resolved` tickets -- `withdrawn` and already-`closed` rows
 * are never candidates, so the run can never revive a terminal ticket --
 * and closes each one whose window has elapsed, with actor `"system"`.
 * Returns the closed ticket ids.
 */
export async function autoCloseResolvedTickets(db: Database, now: Date): Promise<string[]> {
  const candidates = await db.query<{ id: string; resolved_at: string | Date | null }>(
    sql`SELECT id, resolved_at FROM tickets WHERE status = 'resolved' AND resolved_at IS NOT NULL`,
  );

  const closed: string[] = [];
  for (const candidate of candidates) {
    if (!isPastAutoCloseWindow(candidate.resolved_at!, now)) continue;

    await db.transaction(async tx => {
      // Re-check under the lock: a member may have reopened this ticket
      // between the candidate scan and this update.
      const row = await tx.queryOne<TicketRow>(sql`SELECT * FROM tickets WHERE id = ${candidate.id} FOR UPDATE`);
      if (!row || row.status !== 'resolved') return;

      await tx.execute(
        sql`UPDATE tickets SET status = 'closed', closed_at = ${now.toISOString()}, updated_at = now()
            WHERE id = ${candidate.id}`,
      );
      await appendAction(tx, candidate.id, 'closed', 'system');
      closed.push(candidate.id);
    });
  }
  return closed;
}
