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
import { getInvoice, getInvoiceActions, InvoiceConflictError, InvoiceForbiddenError, type Invoice, type InvoiceAction } from './invoices';
import { requireCapability, resolveActor } from '../http/capability-gate';
import { sendConflictError, sendCapabilityRequired } from '../http/problem-response';

/**
 * Translates an invoice's audit trail to the Admin/Mobile OpenAPI's shared
 * `actions` wire shape (STR-085, TC-VEN-029: both surfaces build this from
 * the same `getInvoiceActions` read, so they can never disagree). `notes` is
 * omitted (not sent as `null`) when absent -- the schema declares it a plain
 * string, not required.
 *
 * Events with no recorded actor are dropped rather than sent: the schema's
 * `actor_id` is a required, non-nullable string, but STR-082's submitInvoice
 * writes its own `submitted` event with a nullable, caller-supplied
 * `actorId` (no HTTP route calls submitInvoice yet, so nothing has ever
 * populated it in practice) -- a spec-vs-data gap outside this story's own
 * scope (STR-083/084's verify/approve/reject/override events always set a
 * real actor). Flagged for whichever story ships the submit-invoice HTTP
 * route to always pass one.
 */
export function toActionsResponse(actions: InvoiceAction[]): Record<string, unknown>[] {
  return actions
    .filter(action => action.actorId !== null)
    .map(action => {
      const entry: Record<string, unknown> = { action: action.action, actor_id: action.actorId, at: action.at };
      if (action.notes !== null) entry.notes = action.notes;
      return entry;
    });
}

/**
 * Translates the service layer's camelCase Invoice to the Admin OpenAPI's
 * wire shape, plus `approval_progress` when given -- following
 * test/vendors/invoices.test.ts's own T-C1 translation. `gst_amount`/
 * `invoice_number` are omitted (not sent as `null`) when absent: the
 * OpenAPI schema declares them as plain (non-nullable) Money/string, unlike
 * `resubmission_of`/`resubmitted_as`, which are explicitly `[string, "null"]`.
 * `approval_progress` itself is optional on the schema -- STR-086's `paid`
 * response reuses this same translator with none, since a paid invoice has
 * no active approval threshold to report.
 */
export function toInvoiceResponse(
  invoice: Invoice,
  approvalProgress?: { approved_count: number; required_count: number },
  actions?: InvoiceAction[],
): Record<string, unknown> {
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
  };
  if (approvalProgress) body.approval_progress = approvalProgress;
  if (actions) body.actions = toActionsResponse(actions);
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
      const actor = (await requireCapability(ctx, db, 'designated-verifier')) as { employeeId: string } | null;
      if (!actor) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { notes } = await ctx.request.json();

      try {
        const invoice = await verifyInvoice(db, invoiceId, actor.employeeId, notes ?? null);
        const requiredCount = majorityThreshold(await designatedApproverCount(db));
        const actions = await getInvoiceActions(db, invoiceId);
        ctx.response.send(toInvoiceResponse(invoice, { approved_count: 0, required_count: requiredCount }, actions));
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
        const resolution = await resolveActor(ctx, db);
        if ('failure' in resolution || !('memberId' in resolution.actor)) {
          sendCapabilityRequired(ctx, 'ec-member');
          return;
        }
        const actor = resolution.actor;

        try {
          const { invoice: updated, approvalProgress } = await recordOverrideApproval(db, invoiceId, actor.memberId, notes ?? null);
          const actions = await getInvoiceActions(db, invoiceId);
          ctx.response.send(
            toInvoiceResponse(
              updated,
              { approved_count: approvalProgress.approvedCount, required_count: approvalProgress.requiredCount },
              actions,
            ),
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
      // the gate is guaranteed to return an { memberId } actor here.
      const actor = (await requireCapability(ctx, db, 'designated-approver')) as { memberId: string } | null;
      if (!actor) {
        return;
      }

      try {
        const { invoice: updated, approvalProgress } = await recordApproval(db, invoiceId, actor.memberId, notes ?? null);
        const actions = await getInvoiceActions(db, invoiceId);
        ctx.response.send(
          toInvoiceResponse(
            updated,
            { approved_count: approvalProgress.approvedCount, required_count: approvalProgress.requiredCount },
            actions,
          ),
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
