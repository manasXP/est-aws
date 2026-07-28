// STR-121: the HTTP surfaces for ticket creation and routing config --
// mobile `POST /v1/me/tickets` (X-Actor-Member-Id stub header, the
// me-ownerships-routes convention) and admin `GET`/`PUT /v1/ticket-routing`.
// Thin adapters delegating to tickets.ts.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { raiseTicket, getTicketRouting, replaceTicketRouting, TicketValidationError } from './tickets';
import type { TicketRecord } from './tickets';
import { sendUnauthorized, sendValidationError } from '../http/problem-response';

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

export function registerTicketRoutes(scope: Scope, db: Database): void {
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
}
