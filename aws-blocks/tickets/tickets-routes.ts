// STR-121: the HTTP surfaces for ticket creation and routing config --
// mobile `POST /v1/me/tickets` (the raising member's own bearer token, the
// me-ownerships-routes convention) and admin `GET`/`PUT /v1/ticket-routing`.
// Thin adapters delegating to tickets.ts.
import { RawRoute } from '@aws-blocks/blocks';
import type { BlocksContext, Database, Scope } from '@aws-blocks/blocks';
import { raiseTicket, getTicketRouting, replaceTicketRouting, TicketValidationError } from './tickets';
import type { TicketRecord } from './tickets';
import {
  pickupTicket,
  resolveTicket,
  reopenTicket,
  withdrawTicket,
  TicketLifecycleConflictError,
} from './lifecycle';
import { setTicketWorkOrder } from './work-order-link';
import {
  listTicketsForTriage,
  getTicketDetail,
  listTicketsForMember,
  getTicketDetailForMember,
} from './queries';
import type { TicketAttachmentRecord } from './queries';
import { addComment } from './comments';
import { getMember } from '../members/members-api';
import { getEmployee } from '../employees/employees-api';
import type { TicketCommentRecord } from './comments';
import { createAttachmentUploadSlot, getAttachmentDownloadUrl } from './attachments';
import { DOWNLOAD_URL_EXPIRES_IN_SECONDS } from '../documents/documents-api';
import type { PushAdapter } from '../notifications/push-adapter';
import type { FileBucket } from '@aws-blocks/blocks';
import { sendValidationError, sendConflictError, sendNotFound } from '../http/problem-response';
import { requireMember, requireEmployee, requireAuthenticated } from '../http/capability-gate';

// The mobile Ticket schema: member-facing -- no member_id/assignee_id/
// entered_by exposure (the assignee is STR-126's triage-queue concern).
function toTicketResponse(ticket: TicketRecord): Record<string, unknown> {
  return {
    ticket_id: ticket.ticketId,
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    resolved_at: ticket.resolvedAt,
    closed_at: ticket.closedAt,
    resolution_note: ticket.resolutionNote,
  };
}

// STR-125: the admin Ticket schema -- the full triage view, which unlike
// the member-facing one carries the member and assignee (by id *and* name),
// `entered_by`, and the work-order link. The two name lookups are why this
// one needs the db; STR-126's triage queue is the next consumer.
// STR-126: split from toAdminTicketResponse so the read surfaces, which
// already carry both names out of their own JOIN, can render the same
// shape without re-querying per row.
function adminTicketFields(
  ticket: TicketRecord,
  memberName: string,
  assigneeName: string | null,
): Record<string, unknown> {
  return {
    ticket_id: ticket.ticketId,
    member_id: ticket.memberId,
    member_name: memberName,
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    assignee_id: ticket.assigneeId,
    assignee_name: assigneeName,
    entered_by: ticket.enteredBy,
    work_order_id: ticket.workOrderId,
    resolution_note: ticket.resolutionNote,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
    resolved_at: ticket.resolvedAt,
    closed_at: ticket.closedAt,
  };
}

/** The write paths (STR-125's create and STR-122's transitions) hold only a
 * TicketRecord, so they look the two names up; the read paths do not. */
async function toAdminTicketResponse(db: Database, ticket: TicketRecord): Promise<Record<string, unknown>> {
  const member = await getMember(db, ticket.memberId);
  const assignee = ticket.assigneeId === null ? null : await getEmployee(db, ticket.assigneeId);
  return adminTicketFields(ticket, member!.name, assignee?.name ?? null);
}

// STR-126: the TicketAttachment wire shape, identical on both surfaces.
// `size_bytes` is optional in both schemas and no column records it --
// STR-124 presigns the upload rather than proxying the bytes, so the
// backend never sees the size.
function toAttachmentResponse(attachment: TicketAttachmentRecord): Record<string, unknown> {
  return {
    attachment_id: attachment.attachmentId,
    file_name: attachment.fileName,
    mime_type: attachment.mimeType,
    uploaded_at: attachment.uploadedAt,
  };
}

// STR-123: the shared TicketComment wire shape -- one schema regardless of
// which surface wrote the row. `author_id` stays internal (the OpenAPI
// exposes kind and name only).
function toCommentResponse(comment: TicketCommentRecord): Record<string, unknown> {
  return {
    comment_id: comment.commentId,
    author_kind: comment.authorKind,
    author_name: comment.authorName,
    body: comment.body,
    created_at: comment.createdAt,
  };
}

/** STR-122: maps a lifecycle rejection onto its HTTP status -- 422 for a
 * missing resolution note, 409 for a transition invalid in the ticket's
 * current state (including every attempt on a terminal ticket). Shared by
 * all four transition handlers so neither surface invents its own mapping. */
function sendLifecycleError(ctx: BlocksContext, e: unknown): void {
  if (e instanceof TicketValidationError) {
    sendValidationError(ctx, e);
    return;
  }
  if (e instanceof TicketLifecycleConflictError) {
    sendConflictError(ctx, e);
    return;
  }
  throw e;
}

export function registerTicketRoutes(
  scope: Scope,
  db: Database,
  pushAdapter: PushAdapter,
  bucket: FileBucket,
): void {
  new RawRoute(scope, 'create-ticket', {
    method: 'POST',
    path: '/v1/me/tickets',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      const body = await ctx.request.json();
      try {
        const ticket = await raiseTicket(db, memberId, body?.category, body?.subject, body?.description);
        ctx.response.status = 201;
        ctx.response.send(toTicketResponse(ticket));
      } catch (e) {
        if (e instanceof TicketValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  // STR-125: on-behalf entry for a member who phoned or walked in -- the
  // same creation core as the mobile route above, with the acting admin
  // recorded as `entered_by` (the offline-payment pattern the spec's
  // Decisions name).

  new RawRoute(scope, 'create-ticket-on-behalf', {
    method: 'POST',
    path: '/v1/tickets',
    handler: async ctx => {
      const actorId = await requireEmployee(ctx, db);
      if (!actorId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const ticket = await raiseTicket(db, body?.member_id, body?.category, body?.subject, body?.description, actorId);
        ctx.response.status = 201;
        ctx.response.send(await toAdminTicketResponse(db, ticket));
      } catch (e) {
        if (e instanceof TicketValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'set-ticket-work-order', {
    method: 'PUT',
    path: '/v1/tickets/{ticketId}/work-order',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const body = await ctx.request.json().catch(() => null);
      if (body === null || !('work_order_id' in body)) {
        sendValidationError(ctx, new TicketValidationError('work_order_id is required (null clears the link).'));
        return;
      }

      const { ticketId } = ctx.request.params;
      try {
        const ticket = await setTicketWorkOrder(db, ticketId, body.work_order_id);
        if (!ticket) {
          sendNotFound(ctx, `No ticket ${ticketId}`);
          return;
        }
        ctx.response.send(await toAdminTicketResponse(db, ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  // STR-126: the four read surfaces. All are pure aggregation over
  // queries.ts -- no handler here writes anything, which is the story's
  // Definition of Done. `cursor`/`limit` are accepted per the contract but
  // `next_cursor` is always null, the STR-051/115 precedent: no story has
  // built real cursoring yet.

  new RawRoute(scope, 'list-tickets-triage', {
    method: 'GET',
    path: '/v1/tickets',
    handler: async ctx => {
      const params = ctx.request.url.searchParams;
      // The Admin OpenAPI defaults this queue to `open` -- the triage view
      // is the work still to be done, not the whole history.
      const tickets = await listTicketsForTriage(db, {
        category: params.get('category') ?? undefined,
        status: params.get('status') ?? 'open',
        assigneeId: params.get('assignee_id') ?? undefined,
        memberId: params.get('member_id') ?? undefined,
      });
      ctx.response.send({
        items: tickets.map(t => ({
          ...adminTicketFields(t, t.memberName, t.assigneeName),
          age_days: t.ageDays,
        })),
        next_cursor: null,
      });
    },
  });

  new RawRoute(scope, 'get-ticket-detail', {
    method: 'GET',
    path: '/v1/tickets/{ticketId}',
    handler: async ctx => {
      const { ticketId } = ctx.request.params;
      const detail = await getTicketDetail(db, ticketId);
      if (!detail) {
        sendNotFound(ctx, `No ticket ${ticketId}`);
        return;
      }
      ctx.response.send({
        ...adminTicketFields(detail, detail.memberName, detail.assigneeName),
        comments: detail.comments.map(toCommentResponse),
        attachments: detail.attachments.map(toAttachmentResponse),
        actions: detail.actions.map(a => ({
          action: a.action,
          actor_id: a.actorId,
          at: a.at,
          ...(a.notes === null ? {} : { notes: a.notes }),
        })),
      });
    },
  });

  new RawRoute(scope, 'list-my-tickets', {
    method: 'GET',
    path: '/v1/me/tickets',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      // The mobile contract defaults to every status -- a member tracks
      // their whole history, not just what is still open.
      const tickets = await listTicketsForMember(db, memberId, ctx.request.url.searchParams.get('status') ?? 'all');
      ctx.response.send({ items: tickets.map(toTicketResponse), next_cursor: null });
    },
  });

  new RawRoute(scope, 'get-my-ticket-detail', {
    method: 'GET',
    path: '/v1/me/tickets/{ticketId}',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
        return;
      }

      const { ticketId } = ctx.request.params;
      // 404 rather than 403: "absent" and "someone else's" must be
      // indistinguishable, or the endpoint becomes an existence oracle
      // across members (the STR-124 posture for attachment bytes).
      const detail = await getTicketDetailForMember(db, ticketId, memberId);
      if (!detail) {
        sendNotFound(ctx, `No ticket ${ticketId}`);
        return;
      }
      ctx.response.send({
        ...toTicketResponse(detail),
        comments: detail.comments.map(toCommentResponse),
        attachments: detail.attachments.map(toAttachmentResponse),
      });
    },
  });

  new RawRoute(scope, 'get-ticket-routing', {
    method: 'GET',
    path: '/v1/ticket-routing',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      ctx.response.send(await getTicketRouting(db));
    },
  });

  new RawRoute(scope, 'replace-ticket-routing', {
    method: 'PUT',
    path: '/v1/ticket-routing',
    handler: async ctx => {
      if (!(await requireAuthenticated(ctx, db))) return;

      const body = await ctx.request.json();
      try {
        ctx.response.send(await replaceTicketRouting(db, body));
      } catch (e) {
        if (e instanceof TicketValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  // STR-122's four lifecycle transitions -- each a thin adapter over
  // lifecycle.ts, which owns every status guard. The admin pair acts as an
  // employee (an employee-subject token); the mobile pair acts as the
  // raising member, whose ownership lifecycle.ts re-checks.

  new RawRoute(scope, 'assign-ticket', {
    method: 'POST',
    path: '/v1/tickets/{ticketId}/assign',
    handler: async ctx => {
      const actorId = await requireEmployee(ctx, db);
      if (!actorId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const ticket = await pickupTicket(db, ctx.request.params.ticketId, actorId, body?.assignee_id ?? null);
        ctx.response.send(await toAdminTicketResponse(db, ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'resolve-ticket', {
    method: 'POST',
    path: '/v1/tickets/{ticketId}/resolve',
    handler: async ctx => {
      const actorId = await requireEmployee(ctx, db);
      if (!actorId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const ticket = await resolveTicket(
          db,
          ctx.request.params.ticketId,
          actorId,
          body?.resolution_note,
          pushAdapter,
        );
        ctx.response.send(await toAdminTicketResponse(db, ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'reopen-ticket', {
    method: 'POST',
    path: '/v1/me/tickets/{ticketId}/reopen',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      try {
        const ticket = await reopenTicket(db, ctx.request.params.ticketId, memberId, new Date());
        ctx.response.send(toTicketResponse(ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  // STR-123: the two comment endpoints. Both are thin adapters over
  // comments.ts, which owns the terminal-ticket and ownership guards.

  new RawRoute(scope, 'add-ticket-comment-member', {
    method: 'POST',
    path: '/v1/me/tickets/{ticketId}/comments',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const comment = await addComment(
          db,
          pushAdapter,
          ctx.request.params.ticketId,
          'member',
          memberId,
          body?.body,
        );
        ctx.response.status = 201;
        ctx.response.send(toCommentResponse(comment));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'add-ticket-comment-staff', {
    method: 'POST',
    path: '/v1/tickets/{ticketId}/comments',
    handler: async ctx => {
      const actorId = await requireEmployee(ctx, db);
      if (!actorId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const comment = await addComment(
          db,
          pushAdapter,
          ctx.request.params.ticketId,
          'staff',
          actorId,
          body?.body,
        );
        ctx.response.status = 201;
        ctx.response.send(toCommentResponse(comment));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  // STR-124: ticket-scoped attachments. Both download routes 404 on a null
  // from attachments.ts rather than distinguishing "absent" from
  // "forbidden" -- an existence oracle across members would itself be a
  // small leak, and the OpenAPI declares 404 for both surfaces.

  new RawRoute(scope, 'add-ticket-attachment', {
    method: 'POST',
    path: '/v1/me/tickets/{ticketId}/attachments',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const slot = await createAttachmentUploadSlot(
          db,
          bucket,
          ctx.request.params.ticketId,
          memberId,
          body?.file_name,
          body?.mime_type,
        );
        ctx.response.status = 201;
        ctx.response.send({
          attachment_id: slot.attachmentId,
          upload_url: slot.uploadUrl,
          expires_at: slot.expiresAt,
        });
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'get-ticket-attachment-member', {
    method: 'GET',
    path: '/v1/me/tickets/{ticketId}/attachments/{attachmentId}',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      const { ticketId, attachmentId } = ctx.request.params;
      const url = await getAttachmentDownloadUrl(db, bucket, ticketId, memberId, attachmentId);
      if (!url) {
        sendNotFound(ctx, `No attachment ${attachmentId} on ticket ${ticketId}`);
        return;
      }
      ctx.response.send({
        url,
        expires_at: new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString(),
      });
    },
  });

  new RawRoute(scope, 'get-ticket-attachment-staff', {
    method: 'GET',
    path: '/v1/tickets/{ticketId}/attachments/{attachmentId}',
    handler: async ctx => {
      const actorId = await requireEmployee(ctx, db);
      if (!actorId) {
        return;
      }

      const { ticketId, attachmentId } = ctx.request.params;
      const url = await getAttachmentDownloadUrl(db, bucket, ticketId, 'staff', attachmentId);
      if (!url) {
        sendNotFound(ctx, `No attachment ${attachmentId} on ticket ${ticketId}`);
        return;
      }
      ctx.response.send({
        url,
        expires_at: new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString(),
      });
    },
  });

  new RawRoute(scope, 'withdraw-ticket', {
    method: 'POST',
    path: '/v1/me/tickets/{ticketId}/withdraw',
    handler: async ctx => {
      const memberId = await requireMember(ctx, db);
      if (!memberId) {
        return;
      }

      try {
        const ticket = await withdrawTicket(db, ctx.request.params.ticketId, memberId);
        ctx.response.send(toTicketResponse(ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });
}
