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
import { verifyInvoice, recordApproval, recordOverrideApproval, designatedApproverCount, majorityThreshold } from './invoice-approvals';
import { getInvoice, InvoiceConflictError, InvoiceForbiddenError, type Invoice } from './invoices';
import { requireCapability, resolveActor } from '../http/capability-gate';
import { sendConflictError, sendCapabilityRequired } from '../http/problem-response';

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
      const { invoiceId } = ctx.request.params;
      const { notes } = await ctx.request.json();

      // STR-084: this one endpoint dispatches by the invoice's current
      // status -- `rejected` runs the any-current-EC-member override branch
      // (recordOverrideApproval), any other status (including not-found)
      // falls through to STR-083's designated-approver majority branch
      // (recordApproval) unchanged.
      const invoice = await getInvoice(db, invoiceId);
      if (invoice?.status === 'rejected') {
        const actor = resolveActor(ctx);
        if (!actor || !('memberId' in actor)) {
          sendCapabilityRequired(ctx, 'ec-member');
          return;
        }

        try {
          const { invoice: updated, approvalProgress } = await recordOverrideApproval(db, invoiceId, actor.memberId, notes ?? null);
          ctx.response.send(
            toInvoiceResponse(updated, { approved_count: approvalProgress.approvedCount, required_count: approvalProgress.requiredCount }),
          );
        } catch (e) {
          if (e instanceof InvoiceConflictError) {
            sendConflictError(ctx, e);
            return;
          }
          if (e instanceof InvoiceForbiddenError) {
            sendCapabilityRequired(ctx, 'ec-member');
            return;
          }
          throw e;
        }
        return;
      }

      // Same reasoning as verify-invoice above, mirrored: designated-approver
      // is only ever granted via the memberId branch of buildClaims, so
      // resolveActor is guaranteed to be an { memberId } actor here.
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const actor = resolveActor(ctx) as { memberId: string };

      try {
        const { invoice: updated, approvalProgress } = await recordApproval(db, invoiceId, actor.memberId, notes ?? null);
        ctx.response.send(
          toInvoiceResponse(updated, { approved_count: approvalProgress.approvedCount, required_count: approvalProgress.requiredCount }),
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
