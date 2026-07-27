// STR-086: the Admin API's invoice-payment surface -- `POST
// /v1/invoices/{invoiceId}/payment`, served through RawRoute. Thin HTTP
// adapter: capability gate first (STR-044's requireCapability, unchanged),
// then the Idempotency-Key presence check (STR-042's precedent, unchanged),
// then delegates to invoice-payments.ts for everything else. Mirrors
// employees-routes.ts's `/salary-payments` route and invoice-approvals-
// routes.ts's own structure.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, FileBucket, Scope } from '@aws-blocks/blocks';
import { recordInvoicePayment } from './invoice-payments';
import { InvoiceConflictError, InvoiceValidationError } from './invoices';
import { toInvoiceResponse } from './invoice-approvals-routes';
import { JournalError } from '../finance/journal';
import { requireCapability, resolveActor } from '../http/capability-gate';
import type { Actor } from '../members/capabilities';
import { sendConflictError, sendValidationError, ValidationError, problemResponse } from '../http/problem-response';

export function registerInvoicePaymentRoutes(scope: Scope, db: Database, bucket: FileBucket): void {
  new RawRoute(scope, 'record-invoice-payment', {
    method: 'POST',
    path: '/v1/invoices/{invoiceId}/payment',
    handler: async ctx => {
      // 1. Capability gate (403) -- finance-recorder defaults to the
      // current Treasurer (a member actor) but is delegable to an employee,
      // so unlike verify-invoice/approve-invoice this route can't assume
      // which branch of Actor resolveActor returns.
      if (!(await requireCapability(ctx, db, 'finance-recorder'))) {
        return;
      }

      // 2. Idempotency-Key presence check (422) -- presence-only, same
      // convention as employees-routes.ts's salary-payment endpoint.
      const idempotencyKey = ctx.request.headers.get('Idempotency-Key');
      if (!idempotencyKey) {
        sendValidationError(ctx, new ValidationError('Idempotency-Key header is required.'));
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { method, amount, paid_on, reference } = await ctx.request.json();
      // resolveActor is guaranteed non-null once requireCapability passes
      // above -- an unresolvable actor has no claims, so the gate would
      // already have returned. Unlike verify-invoice/approve-invoice this
      // route can't narrow to one specific branch of Actor (finance-recorder
      // is granted via either), so it's typed as the full union.
      const actor = resolveActor(ctx) as Actor;

      try {
        const invoice = await recordInvoicePayment(db, bucket, invoiceId, actor, {
          method,
          amount,
          paidOn: paid_on,
          reference: reference ?? null,
        });
        ctx.response.status = 201;
        ctx.response.send(toInvoiceResponse(invoice));
      } catch (e) {
        if (e instanceof InvoiceConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof InvoiceValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        // Defense in depth, matching employees-routes.ts's own salary-
        // payment catch for the identical postJournalEntry call: the
        // amount-matches-the-invoice check in recordInvoicePayment already
        // makes this unreachable in practice, but a raw 500 would otherwise
        // leak a JournalError past the route's own 422 contract.
        if (e instanceof JournalError) {
          ctx.response.status = 422;
          ctx.response.send(problemResponse('validation_error', e.message));
          return;
        }
        throw e;
      }
    },
  });
}
