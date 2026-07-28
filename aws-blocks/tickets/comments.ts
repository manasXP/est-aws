// STR-123: the ticket comment thread -- one append-only conversation
// shared by the mobile (`/v1/me/tickets/{id}/comments`) and admin
// (`/v1/tickets/{id}/comments`) surfaces.
//
// The terminal-ticket rule is NOT reimplemented here: this module calls
// STR-122's lockInState with NON_TERMINAL_TICKET_STATUSES, so a `closed`
// or `withdrawn` ticket rejects a comment through exactly the same guard
// that rejects a status transition. That is the epic Risks section's
// "single state-machine module shared by both handlers" mitigation
// extended past transitions to anything touching a terminal ticket.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { getMember } from '../members/members-api';
import { getEmployee } from '../employees/employees-api';
import { TicketValidationError } from './tickets';
import { lockInState, NON_TERMINAL_TICKET_STATUSES, TicketLifecycleConflictError } from './lifecycle';
import type { PushAdapter, PushNotification } from '../notifications/push-adapter';

export type CommentAuthorKind = 'member' | 'staff';

export interface TicketCommentRecord {
  commentId: string;
  authorKind: CommentAuthorKind;
  authorName: string;
  body: string;
  createdAt: string;
}

interface TicketCommentRow {
  id: string;
  author_kind: CommentAuthorKind;
  author_name: string;
  body: string;
  created_at: string | Date;
}

function toComment(row: TicketCommentRow): TicketCommentRecord {
  return {
    commentId: row.id,
    authorKind: row.author_kind,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Appends one comment to a ticket's thread (TC-TKT-008, TC-TKT-020).
 *
 * Guards, in order, all before any write:
 *  - the ticket exists and is non-terminal, via STR-122's shared guard;
 *  - a `member` author is the member who raised the ticket (AC4) -- a
 *    comment endpoint is not a side channel around ticket ownership. Staff
 *    are not ownership-scoped: management works any ticket.
 *
 * A `staff` comment then pushes to the member's registered devices (AC2)
 * through STR-067's `PushAdapter`, with its own copy distinct from the
 * resolution notification. A `member` comment pushes nothing -- staff work
 * the triage queue rather than being paged per comment.
 *
 * `author_name` is captured at write time and stored on the row, so the
 * thread keeps the name as it stood when the comment was posted.
 */
export async function addComment(
  db: Database,
  adapter: PushAdapter,
  ticketId: string,
  authorKind: CommentAuthorKind,
  authorId: string,
  body: string,
): Promise<TicketCommentRecord> {
  if (!body || typeof body !== 'string') {
    throw new TicketValidationError('body is required.');
  }

  const { comment, memberId } = await db.transaction(async tx => {
    const ticket = await lockInState(tx, ticketId, NON_TERMINAL_TICKET_STATUSES);

    let authorName: string;
    if (authorKind === 'member') {
      if (ticket.member_id !== authorId) {
        throw new TicketLifecycleConflictError(`Ticket ${ticketId} was not raised by member ${authorId}.`);
      }
      const member = await getMember(tx, authorId);
      if (!member) {
        throw new TicketLifecycleConflictError(`No member ${authorId}.`);
      }
      authorName = member.name;
    } else {
      const employee = await getEmployee(db, authorId);
      if (!employee) {
        throw new TicketLifecycleConflictError(`No employee ${authorId}.`);
      }
      authorName = employee.name;
    }

    const row = await tx.queryOne<TicketCommentRow>(
      sql`INSERT INTO ticket_comments (id, ticket_id, author_kind, author_id, author_name, body)
          VALUES (${randomUUID()}, ${ticketId}, ${authorKind}, ${authorId}, ${authorName}, ${body})
          RETURNING *`,
    );
    return { comment: toComment(row!), memberId: ticket.member_id };
  });

  if (authorKind === 'staff') {
    const devices = await db.query<{ push_token: string }>(
      sql`SELECT push_token FROM registered_devices WHERE member_id = ${memberId}`,
    );
    const notification: PushNotification = {
      title: 'New reply on your request',
      body: 'Management has replied to your request -- open the app to read it.',
    };
    for (const device of devices) {
      await adapter.send(device.push_token, notification);
    }
  }

  return comment;
}

/** The ordered thread behind both surfaces' ticket-detail responses
 * (STR-126 embeds it). Ordered by the monotonic `seq`, not `created_at` --
 * see migrations/041 for why a timestamp is not a safe ordering key here. */
export async function getTicketThread(db: Database, ticketId: string): Promise<TicketCommentRecord[]> {
  const rows = await db.query<TicketCommentRow>(
    sql`SELECT * FROM ticket_comments WHERE ticket_id = ${ticketId} ORDER BY seq`,
  );
  return rows.map(toComment);
}
