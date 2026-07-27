// STR-083: the Admin API's invoice sign-off surface -- `POST
// /v1/invoices/{invoiceId}/verify` and `POST /v1/invoices/{invoiceId}/approve`,
// served through RawRoute (the STR-003-decided mechanism). The first
// vendor-workflow story to ship real HTTP routes (STR-081/082 stayed
// service-layer only). Thin HTTP adapter: capability gate first (STR-044's
// requireCapability, unchanged), then parses path/body, then delegates to
// invoice-approvals.ts for everything else. Mirrors employees-routes.ts's
// `/salary-payments` route (capability gate first, then business logic).
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope } from '@aws-blocks/blocks';
import { verifyInvoice, recordApproval, designatedApproverCount, majorityThreshold } from './invoice-approvals';
import type { Invoice } from './invoices';
import { InvoiceConflictError } from './invoices';
import { requireCapability, resolveActor } from '../http/capability-gate';
import { sendConflictError } from '../http/problem-response';

/**
 * Translates the service layer's camelCase Invoice to the Admin OpenAPI's
 * wire shape, plus `approval_progress` -- following
 * test/vendors/invoices.test.ts's own T-C1 translation. `gst_amount`/
 * `invoice_number` are omitted (not sent as `null`) when absent: the
 * OpenAPI schema declares them as plain (non-nullable) Money/string, unlike
 * `resubmission_of`/`resubmitted_as`, which are explicitly `[string, "null"]`.
 */
function toInvoiceResponse(invoice: Invoice, approvalProgress: { approved_count: number; required_count: number }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    invoice_id: invoice.id,
    work_order_id: invoice.workOrderId,
    vendor_id: invoice.vendorId,
    amount: invoice.amount,
    status: invoice.status,
    invoice_date: invoice.invoiceDate,
    document_id: invoice.documentId,
    resubmission_of: invoice.resubmissionOf,
    resubmitted_as: invoice.resubmittedAs,
    approval_progress: approvalProgress,
  };
  if (invoice.gstAmount !== null) body.gst_amount = invoice.gstAmount;
  if (invoice.invoiceNumber !== null) body.invoice_number = invoice.invoiceNumber;
  return body;
}

export function registerInvoiceApprovalRoutes(scope: Scope, db: Database): void {
  new RawRoute(scope, 'verify-invoice', {
    method: 'POST',
    path: '/v1/invoices/{invoiceId}/verify',
    handler: async ctx => {
      // requireCapability already rejects a member actor or no actor here:
      // buildClaims only ever grants designated-verifier via the employeeId
      // branch (an employee's own `capabilities` column), never the
      // memberId branch -- so resolveActor is guaranteed to be an
      // { employeeId } actor once this gate passes.
      if (!(await requireCapability(ctx, db, 'designated-verifier'))) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { notes } = await ctx.request.json();
      const actor = resolveActor(ctx) as { employeeId: string };

      try {
        const invoice = await verifyInvoice(db, invoiceId, actor.employeeId, notes ?? null);
        const requiredCount = majorityThreshold(await designatedApproverCount(db));
        ctx.response.send(toInvoiceResponse(invoice, { approved_count: 0, required_count: requiredCount }));
      } catch (e) {
        if (e instanceof InvoiceConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'approve-invoice', {
    method: 'POST',
    path: '/v1/invoices/{invoiceId}/approve',
    handler: async ctx => {
      // Same reasoning as verify-invoice above, mirrored: designated-approver
      // is only ever granted via the memberId branch of buildClaims, so
      // resolveActor is guaranteed to be an { memberId } actor here.
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { notes } = await ctx.request.json();
      const actor = resolveActor(ctx) as { memberId: string };

      try {
        const { invoice, approvalProgress } = await recordApproval(db, invoiceId, actor.memberId, notes ?? null);
        ctx.response.send(
          toInvoiceResponse(invoice, { approved_count: approvalProgress.approvedCount, required_count: approvalProgress.requiredCount }),
        );
      } catch (e) {
        if (e instanceof InvoiceConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
