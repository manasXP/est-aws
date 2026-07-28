// STR-121: ticket creation and category-based routing (Member Requests
// spec) -- the E13 foundation. Lifecycle transitions are STR-122's;
// comments/attachments/on-behalf entry/read surfaces follow in
// STR-123..126. Kept separate from the HTTP layer (tickets-routes.ts) so
// it's testable with a plain Database -- the employees-api/-routes split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import { getEmployee } from '../employees/employees-api';
import { getMember } from '../members/members-api';

// The fixed v1 category enum (a management-editable list is a spec-named
// fast-follow). Single source of truth for STR-122..126's handlers; the
// migration CHECK constraints mirror it (story Refactor note).
export const TICKET_CATEGORIES = ['finance', 'maintenance', 'records', 'general'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | 'withdrawn';

/** Domain rejection for a ticket or routing write -- nothing is written
 * when this is thrown. */
export class TicketValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'TicketValidationError';
  }
}

export interface TicketRecord {
  ticketId: string;
  memberId: string;
  category: TicketCategory;
  subject: string;
  description: string;
  status: TicketStatus;
  assigneeId: string | null;
  enteredBy: string | null;
  workOrderId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

/** The raw `tickets` row shape — exported for STR-122's lifecycle.ts, which
 * reads and updates the same table under `FOR UPDATE`. */
export interface TicketRow {
  id: string;
  member_id: string;
  category: TicketCategory;
  subject: string;
  description: string;
  status: TicketStatus;
  assignee_id: string | null;
  entered_by: string | null;
  work_order_id: string | null;
  resolution_note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  resolved_at: string | Date | null;
  closed_at: string | Date | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Row → API record. Exported so STR-122's lifecycle.ts returns the same
 * shape from its transitions rather than re-deriving the mapping. */
export function toTicket(row: TicketRow): TicketRecord {
  return {
    ticketId: row.id,
    memberId: row.member_id,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    assigneeId: row.assignee_id,
    enteredBy: row.entered_by,
    workOrderId: row.work_order_id,
    resolutionNote: row.resolution_note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    closedAt: row.closed_at === null ? null : toIso(row.closed_at),
  };
}

/**
 * `POST /me/tickets` business logic (AC1/AC2/AC4, TC-TKT-001): validates
 * the fixed category enum and the subject/description, resolves the
 * category's default assignee from ticket_routing (`null` when unrouted --
 * a triage-visibility gap, never a blocked creation, T-U3), and inserts
 * the ticket `open`.
 *
 * STR-125: also the admin `POST /v1/tickets` on-behalf path -- one extra
 * `enteredBy` argument, one shared insert, rather than a second creation
 * path that could drift on routing or status. `enteredBy` stays `null` on
 * the member-raised mobile surface.
 */
export async function raiseTicket(
  db: Database,
  memberId: string,
  category: string,
  subject: string,
  description: string,
  enteredBy: string | null = null,
): Promise<TicketRecord> {
  if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) {
    throw new TicketValidationError(`category must be one of ${TICKET_CATEGORIES.join(', ')}.`);
  }
  if (!subject || typeof subject !== 'string') {
    throw new TicketValidationError('subject is required.');
  }
  if (subject.length > 200) {
    throw new TicketValidationError('subject must be at most 200 characters.');
  }
  if (!description || typeof description !== 'string') {
    throw new TicketValidationError('description is required.');
  }

  // STR-125 T-U2: on the on-behalf path the member is named in the request
  // body rather than proven by the caller's own session, so an unknown id
  // must be a clean rejection, not the raw FK violation the insert would
  // otherwise raise.
  const member = await getMember(db, memberId);
  if (!member) {
    throw new TicketValidationError(`No member ${memberId}.`);
  }

  const routed = await db.queryOne<{ assignee_id: string }>(
    sql`SELECT assignee_id FROM ticket_routing WHERE category = ${category}`,
  );

  const ticketId = randomUUID();
  // STR-122: the `opened` row is the first entry in the append-only
  // status-history trail (migrations/040), written in the same transaction
  // as the ticket itself so a ticket can never exist without its opening
  // audit entry.
  const row = await db.transaction(async tx => {
    const inserted = await tx.queryOne<TicketRow>(
      sql`INSERT INTO tickets (id, member_id, category, subject, description, assignee_id, entered_by)
          VALUES (${ticketId}, ${memberId}, ${category}, ${subject}, ${description}, ${routed?.assignee_id ?? null}, ${enteredBy})
          RETURNING *`,
    );
    await tx.execute(
      sql`INSERT INTO ticket_actions (id, ticket_id, action, actor_id)
          VALUES (${randomUUID()}, ${ticketId}, 'opened', ${memberId})`,
    );
    return inserted;
  });
  return toTicket(row!);
}

/** `GET /v1/ticket-routing` -- the configured default assignee per
 * category; keys absent for unrouted categories (see the contract wrinkle
 * recorded in this story's PR: TicketRouting has no schema-valid answer
 * before full configuration). */
export async function getTicketRouting(db: Database): Promise<Record<string, string>> {
  const rows = await db.query<{ category: string; assignee_id: string }>(
    sql`SELECT category, assignee_id FROM ticket_routing`,
  );
  return Object.fromEntries(rows.map(row => [row.category, row.assignee_id]));
}

/**
 * `PUT /v1/ticket-routing` business logic (AC3): replaces the whole
 * configuration -- the STR-057/043/113 replace-semantics precedent. All
 * four categories are required (the OpenAPI TicketRouting schema), every
 * assignee must be an employee with an admin account (non-empty
 * capabilities, STR-042's designated-account flag), and the write is
 * all-or-nothing: any rejection writes nothing.
 */
export async function replaceTicketRouting(db: Database, routing: unknown): Promise<Record<string, string>> {
  if (routing === null || typeof routing !== 'object') {
    throw new TicketValidationError('routing must be an object with all four categories.');
  }
  const entries = routing as Record<string, unknown>;
  for (const category of TICKET_CATEGORIES) {
    if (typeof entries[category] !== 'string' || entries[category] === '') {
      throw new TicketValidationError(`routing.${category} is required.`);
    }
  }

  const assignees = TICKET_CATEGORIES.map(category => [category, entries[category] as string] as const);
  for (const [category, employeeId] of assignees) {
    const employee = await getEmployee(db, employeeId);
    if (!employee) {
      throw new TicketValidationError(`No employee ${employeeId} (routing.${category}).`);
    }
    if (employee.capabilities.length === 0) {
      throw new TicketValidationError(
        `Employee ${employeeId} (routing.${category}) has no admin account -- ticket routing requires one.`,
      );
    }
  }

  await db.transaction(async tx => {
    await tx.execute(sql`DELETE FROM ticket_routing`);
    for (const [category, employeeId] of assignees) {
      await tx.execute(sql`INSERT INTO ticket_routing (category, assignee_id) VALUES (${category}, ${employeeId})`);
    }
  });

  return Object.fromEntries(assignees);
}
