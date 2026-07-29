// STR-126: the E13 read surfaces -- the admin triage queue and the
// member's own-tickets view. Pure aggregation over what STR-121..125
// already write: nothing in this module issues an INSERT, UPDATE or
// DELETE, which is the story's Definition of Done ("no filter or read path
// in the diff writes to any ticket table") and the reason ageing here
// cannot escalate anything (TC-TKT-025).
//
// The two detail queries share one assembly function and differ only in
// their ownership gate (the story's Refactor note), so the member view can
// never drift into exposing a field the admin view added.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { toTicket } from './tickets';
import type { TicketRecord, TicketRow, TicketStatus } from './tickets';
import { getTicketThread } from './comments';
import type { TicketCommentRecord } from './comments';

/** A queue row: the ticket plus its read-time age. `ageDays` is derived on
 * every read and stored nowhere -- v1 has no SLA machinery, so age is a
 * view, never state (Member Requests Decisions: "escalation happens
 * offline"). */
export interface TriageTicket extends TicketRecord {
  ageDays: number;
  memberName: string;
  assigneeName: string | null;
}

/** `tickets` joined to the two name sources the admin `Ticket` schema
 * requires. Joined in SQL rather than looked up per row -- a triage queue
 * is the one E13 read that returns many tickets at once, so a per-row
 * lookup would be N+1 by construction.
 *
 * The join is spelled out at each of the three call sites below rather
 * than hoisted into a shared constant: `sql` interpolations are bound
 * parameters, so a nested `sql` fragment is passed as a *value*, not
 * spliced as SQL text (it fails with a 42601 syntax error). */
interface JoinedTicketRow extends TicketRow {
  member_name: string;
  assignee_name: string | null;
}

export interface TicketAttachmentRecord {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
}

export interface TicketActionRecord {
  action: string;
  actorId: string;
  at: string;
  notes: string | null;
}

export interface TicketDetailRecord extends TicketRecord {
  memberName: string;
  assigneeName: string | null;
  comments: TicketCommentRecord[];
  attachments: TicketAttachmentRecord[];
  actions: TicketActionRecord[];
}

export interface TriageFilters {
  category?: string;
  /** Omitted or `'all'` means every status. */
  status?: string;
  assigneeId?: string;
  memberId?: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function ageDays(createdAt: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Admin `GET /v1/tickets` (AC1/AC2, TC-TKT-025): the ageing view.
 *
 * Ordered oldest-first, per the OpenAPI's own description of the queue.
 * Every filter is optional and they compose conjunctively; `status: 'all'`
 * (or omitted) means no status restriction, matching both surfaces' enum.
 * `now` is injected rather than read inside, the STR-122 clock convention,
 * so age is testable without a live clock.
 */
export async function listTicketsForTriage(
  db: Database,
  filters: TriageFilters,
  now: Date = new Date(),
): Promise<TriageTicket[]> {
  const status = filters.status === 'all' ? undefined : filters.status;
  const rows = await db.query<JoinedTicketRow>(
    sql`SELECT t.*, m.name AS member_name, e.name AS assignee_name
        FROM tickets t
        JOIN members m ON m.id = t.member_id
        LEFT JOIN employees e ON e.id = t.assignee_id
        WHERE (${filters.category ?? null}::text IS NULL OR t.category = ${filters.category ?? null})
          AND (${status ?? null}::text IS NULL OR t.status = ${status ?? null})
          AND (${filters.assigneeId ?? null}::text IS NULL OR t.assignee_id = ${filters.assigneeId ?? null})
          AND (${filters.memberId ?? null}::text IS NULL OR t.member_id = ${filters.memberId ?? null})
        ORDER BY t.created_at, t.id`,
  );
  return rows.map(row => {
    const ticket = toTicket(row);
    return {
      ...ticket,
      ageDays: ageDays(ticket.createdAt, now),
      memberName: row.member_name,
      assigneeName: row.assignee_name,
    };
  });
}

/**
 * Mobile `GET /me/tickets` (AC4, TC-TKT-026): the member's own tickets and
 * only those. Ownership is a WHERE clause on the same query the triage
 * queue uses rather than a post-filter, so there is no shape in which an
 * unowned row is fetched and then dropped.
 */
export async function listTicketsForMember(
  db: Database,
  memberId: string,
  status?: string,
  now: Date = new Date(),
): Promise<TriageTicket[]> {
  return listTicketsForTriage(db, { memberId, status }, now);
}

/** The shared `TicketDetail` assembly -- one set of joins behind both
 * surfaces (the story's Refactor note). Returns `null` when the ticket does
 * not exist, which both routes render as 404. */
async function assembleDetail(db: Database, row: JoinedTicketRow): Promise<TicketDetailRecord> {
  const [comments, attachmentRows, actionRows] = await Promise.all([
    getTicketThread(db, row.id),
    db.query<{ id: string; file_name: string; mime_type: string; uploaded_at: string | Date }>(
      sql`SELECT id, file_name, mime_type, uploaded_at FROM ticket_attachments
          WHERE ticket_id = ${row.id} ORDER BY uploaded_at, id`,
    ),
    db.query<{ action: string; actor_id: string; at: string | Date; notes: string | null }>(
      sql`SELECT action, actor_id, at, notes FROM ticket_actions
          WHERE ticket_id = ${row.id} ORDER BY at, id`,
    ),
  ]);

  return {
    ...toTicket(row),
    memberName: row.member_name,
    assigneeName: row.assignee_name,
    comments,
    attachments: attachmentRows.map(a => ({
      attachmentId: a.id,
      fileName: a.file_name,
      mimeType: a.mime_type,
      uploadedAt: toIso(a.uploaded_at),
    })),
    actions: actionRows.map(a => ({
      action: a.action,
      actorId: a.actor_id,
      at: toIso(a.at),
      notes: a.notes,
    })),
  };
}

/** Admin `GET /v1/tickets/{ticketId}` (AC3). Staff are not ownership-scoped
 * -- ticket handling sits under the general admin roles with no dedicated
 * capability (Member Requests "Surfaces"). */
export async function getTicketDetail(db: Database, ticketId: string): Promise<TicketDetailRecord | null> {
  const row = await db.queryOne<JoinedTicketRow>(
    sql`SELECT t.*, m.name AS member_name, e.name AS assignee_name
        FROM tickets t
        JOIN members m ON m.id = t.member_id
        LEFT JOIN employees e ON e.id = t.assignee_id
        WHERE t.id = ${ticketId}`,
  );
  return row ? assembleDetail(db, row) : null;
}

/**
 * Mobile `GET /me/tickets/{ticketId}` (AC4, T-U3): the same detail behind
 * an ownership gate.
 *
 * The ownership check is part of the lookup, and nothing is assembled
 * before it passes -- so a stranger's request never reads the thread or
 * history at all, and "absent" and "not yours" are indistinguishable from
 * outside. That is the same posture STR-124 took for attachment bytes,
 * extended to the ticket record itself.
 */
export async function getTicketDetailForMember(
  db: Database,
  ticketId: string,
  memberId: string,
): Promise<TicketDetailRecord | null> {
  const row = await db.queryOne<JoinedTicketRow>(
    sql`SELECT t.*, m.name AS member_name, e.name AS assignee_name
        FROM tickets t
        JOIN members m ON m.id = t.member_id
        LEFT JOIN employees e ON e.id = t.assignee_id
        WHERE t.id = ${ticketId} AND t.member_id = ${memberId}`,
  );
  return row ? assembleDetail(db, row) : null;
}

/** Re-exported for the routes, which need the status enum to validate the
 * `?status=` query parameter against the same list the tables constrain. */
export const QUERYABLE_TICKET_STATUSES: ReadonlyArray<TicketStatus | 'all'> = [
  'open',
  'in_progress',
  'resolved',
  'closed',
  'withdrawn',
  'all',
];
