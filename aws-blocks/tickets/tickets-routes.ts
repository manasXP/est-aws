// STR-121: the HTTP surfaces for ticket creation and routing config --
// mobile `POST /v1/me/tickets` (X-Actor-Member-Id stub header, the
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
import { addComment } from './comments';
import type { TicketCommentRecord } from './comments';
import { createAttachmentUploadSlot, getAttachmentDownloadUrl } from './attachments';
import { DOWNLOAD_URL_EXPIRES_IN_SECONDS } from '../documents/documents-api';
import type { PushAdapter } from '../notifications/push-adapter';
import type { FileBucket } from '@aws-blocks/blocks';
import { sendUnauthorized, sendValidationError, sendConflictError, sendNotFound } from '../http/problem-response';

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
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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

  new RawRoute(scope, 'get-ticket-routing', {
    method: 'GET',
    path: '/v1/ticket-routing',
    handler: async ctx => {
      ctx.response.send(await getTicketRouting(db));
    },
  });

  new RawRoute(scope, 'replace-ticket-routing', {
    method: 'PUT',
    path: '/v1/ticket-routing',
    handler: async ctx => {
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
  // employee (X-Actor-Employee-Id); the mobile pair acts as the raising
  // member (X-Actor-Member-Id), whose ownership lifecycle.ts re-checks.

  new RawRoute(scope, 'assign-ticket', {
    method: 'POST',
    path: '/v1/tickets/{ticketId}/assign',
    handler: async ctx => {
      const actorId = ctx.request.headers.get('X-Actor-Employee-Id');
      if (!actorId) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id header is required.');
        return;
      }

      const body = await ctx.request.json().catch(() => null);
      try {
        const ticket = await pickupTicket(db, ctx.request.params.ticketId, actorId, body?.assignee_id ?? null);
        ctx.response.send(toTicketResponse(ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'resolve-ticket', {
    method: 'POST',
    path: '/v1/tickets/{ticketId}/resolve',
    handler: async ctx => {
      const actorId = ctx.request.headers.get('X-Actor-Employee-Id');
      if (!actorId) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id header is required.');
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
        ctx.response.send(toTicketResponse(ticket));
      } catch (e) {
        sendLifecycleError(ctx, e);
      }
    },
  });

  new RawRoute(scope, 'reopen-ticket', {
    method: 'POST',
    path: '/v1/me/tickets/{ticketId}/reopen',
    handler: async ctx => {
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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
      const actorId = ctx.request.headers.get('X-Actor-Employee-Id');
      if (!actorId) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id header is required.');
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
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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
      const actorId = ctx.request.headers.get('X-Actor-Employee-Id');
      if (!actorId) {
        sendUnauthorized(ctx, 'X-Actor-Employee-Id header is required.');
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
      const memberId = ctx.request.headers.get('X-Actor-Member-Id');
      if (!memberId) {
        sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
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
