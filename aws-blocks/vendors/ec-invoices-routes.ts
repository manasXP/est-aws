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
  invoiceHasOverrideVotes,
  majorityThreshold,
} from './invoice-approvals';
import { toActionsResponse } from './invoice-approvals-routes';
import { requireCapability, resolveActor } from '../http/capability-gate';
import { sendNotFound, sendConflictError, sendCapabilityRequired, sendValidationError } from '../http/problem-response';
import { DOWNLOAD_URL_EXPIRES_IN_SECONDS } from '../documents/documents-api';

/**
 * Live `approval_progress` for a read with no write of its own to report it
 * from (STR-085 code review fix): a `rejected` invoice is always mid-override,
 * so it reports the EC-override count/threshold. Any other status could have
 * been resolved either way -- `invoiceHasOverrideVotes` (a raw existence
 * check, not scoped to currently-open EC members) tells them apart: once any
 * override vote was ever cast, the invoice can only have left `rejected` via
 * the override branch (recordApproval never runs against a `rejected`
 * invoice), so it keeps reporting the override count/threshold even after
 * flipping to `approved`. Everything else (never rejected) reports the
 * normal designated-approver count/threshold.
 */
async function approvalProgressFor(db: Database, invoice: Invoice): Promise<{ approved_count: number; required_count: number }> {
  if (invoice.status === 'rejected' || (await invoiceHasOverrideVotes(db, invoice.id))) {
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
 * fields (TC-VEN-029). `approvalProgress` is optional: the approve/override
 * routes below already have it from the write itself (recordApproval/
 * recordOverrideApproval's own return value) and must forward that exact
 * value rather than re-derive it -- re-deriving immediately after an
 * override-approval would still see the pre-write EC-membership snapshot
 * consistently, but re-running the query at all here was the code-review-
 * caught bug's root cause, so write call sites now always pass their own
 * result through instead of leaving it to chance.
 */
async function toMobileInvoiceResponse(
  db: Database,
  invoice: Invoice,
  approvalProgress?: { approved_count: number; required_count: number },
): Promise<Record<string, unknown>> {
  const [workOrder, vendor, actions, progress] = await Promise.all([
    getWorkOrder(db, invoice.workOrderId),
    getVendor(db, invoice.vendorId),
    getInvoiceActions(db, invoice.id),
    approvalProgress ?? approvalProgressFor(db, invoice),
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
    approval_progress: progress,
    actions: toActionsResponse(actions),
  };
  if (invoice.gstAmount !== null) body.gst_amount = invoice.gstAmount;
  if (invoice.invoiceNumber !== null) body.invoice_number = invoice.invoiceNumber;
  return body;
}

// Code review fix: the Mobile OpenAPI's own `status` enum for this endpoint
// is `[verified, approved, rejected, all]` -- deliberately narrower than the
// Admin `/invoices` enum (which also allows `submitted`/`paid`) this list
// had been copied from. `submitted` invoices haven't reached the EC yet and
// aren't part of this inbox's contract.
const LIST_STATUSES: readonly (InvoiceStatus | 'all')[] = ['verified', 'approved', 'rejected', 'all'];

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
        const resolution = await resolveActor(ctx, db);
        if ('failure' in resolution || !('memberId' in resolution.actor)) {
          sendCapabilityRequired(ctx, 'ec-member');
          return;
        }
        const actor = resolution.actor;

        try {
          const { invoice: updated, approvalProgress } = await recordOverrideApproval(db, invoiceId, actor.memberId, notes ?? null);
          ctx.response.send(
            await toMobileInvoiceResponse(db, updated, {
              approved_count: approvalProgress.approvedCount,
              required_count: approvalProgress.requiredCount,
            }),
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

      const actor = (await requireCapability(ctx, db, 'designated-approver')) as { memberId: string } | null;
      if (!actor) {
        return;
      }

      try {
        const { invoice: updated, approvalProgress } = await recordApproval(db, invoiceId, actor.memberId, notes ?? null);
        ctx.response.send(
          await toMobileInvoiceResponse(db, updated, {
            approved_count: approvalProgress.approvedCount,
            required_count: approvalProgress.requiredCount,
          }),
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

  new RawRoute(scope, 'reject-ec-invoice', {
    method: 'POST',
    path: '/v1/ec/invoices/{invoiceId}/reject',
    handler: async ctx => {
      const actor = (await requireCapability(ctx, db, 'designated-approver')) as { memberId: string } | null;
      if (!actor) {
        return;
      }

      const { invoiceId } = ctx.request.params;
      const { reason } = await ctx.request.json();

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
