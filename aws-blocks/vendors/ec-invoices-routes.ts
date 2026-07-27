// STR-085: the Mobile Public API's EC approval inbox -- `/v1/ec/invoices*`,
// served through RawRoute (the STR-003-decided mechanism). Thin adapters
// directly over STR-083/084's shared invoice-approvals.ts functions
// (recordApproval, recordOverrideApproval, rejectInvoice, all unchanged) --
// no second workflow implementation exists to disagree with the admin
// surface (invoice-approvals-routes.ts). Capability gating mirrors the
// Mobile Public API's own "EC approval inbox (designated approvers only)"
// section exactly: every read and the reject write require
// designated-approver; only the approve endpoint's rejected-invoice branch
// opens to any current EC member (STR-084's isCurrentEcMember), the same
// dispatch-by-status shape invoice-approvals-routes.ts already established
// for the admin surface.
import { RawRoute } from '@aws-blocks/blocks';
import type { Database, Scope, FileBucket } from '@aws-blocks/blocks';
import {
  getInvoice,
  getInvoiceActions,
  listInvoices,
  InvoiceConflictError,
  InvoiceForbiddenError,
  InvoiceValidationError,
  type Invoice,
  type InvoiceStatus,
} from './invoices';
import { getWorkOrder, getVendor } from './work-orders';
import {
  recordApproval,
  recordOverrideApproval,
  rejectInvoice,
  designatedApproverCount,
  currentEcMemberCount,
  normalApprovalCount,
  overrideApprovalCount,
  majorityThreshold,
} from './invoice-approvals';
import { toActionsResponse } from './invoice-approvals-routes';
import { requireCapability, resolveActor } from '../http/capability-gate';
import { sendNotFound, sendConflictError, sendCapabilityRequired, sendValidationError } from '../http/problem-response';
import { DOWNLOAD_URL_EXPIRES_IN_SECONDS } from '../documents/documents-api';

/**
 * Live `approval_progress` for a read (STR-085): a `rejected` invoice reports
 * the EC-override count/threshold, everything else reports the normal
 * designated-approver count/threshold -- the same status-based split
 * recordApproval/recordOverrideApproval already apply on write, and
 * `/v1/invoices/{id}/approve`'s own dispatch applies on the admin surface.
 */
async function approvalProgressFor(db: Database, invoice: Invoice): Promise<{ approved_count: number; required_count: number }> {
  if (invoice.status === 'rejected') {
    const approvedCount = await overrideApprovalCount(db, invoice.id);
    const requiredCount = majorityThreshold(await currentEcMemberCount(db));
    return { approved_count: approvedCount, required_count: requiredCount };
  }
  const approvedCount = await normalApprovalCount(db, invoice.id);
  const requiredCount = majorityThreshold(await designatedApproverCount(db));
  return { approved_count: approvedCount, required_count: requiredCount };
}

/**
 * Translates the service layer's Invoice to the Mobile OpenAPI's wire shape.
 * Unlike the admin contract, mobile carries `vendor_name`/`work_order_scope`
 * for display (no `document_id` -- the scanned document is its own
 * `.../document` endpoint) but shares the same `approval_progress`/`actions`
 * fields, built from the identical `getInvoiceActions`/`approvalProgressFor`
 * reads the admin surface uses (TC-VEN-029).
 */
async function toMobileInvoiceResponse(db: Database, invoice: Invoice): Promise<Record<string, unknown>> {
  const [workOrder, vendor, actions, approvalProgress] = await Promise.all([
    getWorkOrder(db, invoice.workOrderId),
    getVendor(db, invoice.vendorId),
    getInvoiceActions(db, invoice.id),
    approvalProgressFor(db, invoice),
  ]);
  const body: Record<string, unknown> = {
    invoice_id: invoice.id,
    work_order_id: invoice.workOrderId,
    work_order_scope: workOrder!.scope,
    vendor_name: vendor!.name,
    amount: invoice.amount,
    status: invoice.status,
    invoice_date: invoice.invoiceDate,
    resubmission_of: invoice.resubmissionOf,
    resubmitted_as: invoice.resubmittedAs,
    approval_progress: approvalProgress,
    actions: toActionsResponse(actions),
  };
  if (invoice.gstAmount !== null) body.gst_amount = invoice.gstAmount;
  if (invoice.invoiceNumber !== null) body.invoice_number = invoice.invoiceNumber;
  return body;
}

const LIST_STATUSES: readonly (InvoiceStatus | 'all')[] = ['submitted', 'verified', 'approved', 'rejected', 'paid', 'all'];

export function registerEcInvoiceRoutes(scope: Scope, db: Database, bucket: FileBucket): void {
  new RawRoute(scope, 'list-ec-invoices', {
    method: 'GET',
    path: '/v1/ec/invoices',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const statusParam = ctx.request.url.searchParams.get('status') ?? 'verified';
      const status = (LIST_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as InvoiceStatus | 'all') : 'verified';
      const invoices = await listInvoices(db, status);
      const items = await Promise.all(invoices.map(invoice => toMobileInvoiceResponse(db, invoice)));
      ctx.response.send({ items, next_cursor: null });
    },
  });

  new RawRoute(scope, 'get-ec-invoice', {
    method: 'GET',
    path: '/v1/ec/invoices/{invoiceId}',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const invoice = await getInvoice(db, invoiceId);
      if (!invoice) {
        sendNotFound(ctx, `No invoice ${invoiceId}`);
        return;
      }
      ctx.response.send(await toMobileInvoiceResponse(db, invoice));
    },
  });

  new RawRoute(scope, 'get-ec-invoice-document', {
    method: 'GET',
    path: '/v1/ec/invoices/{invoiceId}/document',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const invoice = await getInvoice(db, invoiceId);
      if (!invoice) {
        sendNotFound(ctx, `No invoice ${invoiceId}`);
        return;
      }

      const url = await bucket.getUrl(invoice.documentId, { expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
      const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();
      ctx.response.send({ url, expires_at: expiresAt });
    },
  });

  new RawRoute(scope, 'approve-ec-invoice', {
    method: 'POST',
    path: '/v1/ec/invoices/{invoiceId}/approve',
    handler: async ctx => {
      const { invoiceId } = ctx.request.params;
      const { notes } = await ctx.request.json();

      // Same status-based dispatch as the admin surface's approve-invoice
      // route: `rejected` runs the any-current-EC-member override branch,
      // any other status (including not-found) falls through to the
      // designated-approver majority branch.
      const invoice = await getInvoice(db, invoiceId);
      if (invoice?.status === 'rejected') {
        const actor = resolveActor(ctx);
        if (!actor || !('memberId' in actor)) {
          sendCapabilityRequired(ctx, 'ec-member');
          return;
        }

        try {
          const { invoice: updated } = await recordOverrideApproval(db, invoiceId, actor.memberId, notes ?? null);
          ctx.response.send(await toMobileInvoiceResponse(db, updated));
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

      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const actor = resolveActor(ctx) as { memberId: string };

      try {
        const { invoice: updated } = await recordApproval(db, invoiceId, actor.memberId, notes ?? null);
        ctx.response.send(await toMobileInvoiceResponse(db, updated));
      } catch (e) {
        if (e instanceof InvoiceConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });

  new RawRoute(scope, 'reject-ec-invoice', {
    method: 'POST',
    path: '/v1/ec/invoices/{invoiceId}/reject',
    handler: async ctx => {
      if (!(await requireCapability(ctx, db, 'designated-approver'))) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { reason } = await ctx.request.json();
      const actor = resolveActor(ctx) as { memberId: string };

      try {
        const updated = await rejectInvoice(db, invoiceId, actor.memberId, reason);
        ctx.response.send(await toMobileInvoiceResponse(db, updated));
      } catch (e) {
        if (e instanceof InvoiceConflictError) {
          sendConflictError(ctx, e);
          return;
        }
        if (e instanceof InvoiceValidationError) {
          sendValidationError(ctx, e);
          return;
        }
        throw e;
      }
    },
  });
}
