import { Scope, Database, FileBucket, RawRoute, CronJob, Logger, Metrics } from '@aws-blocks/blocks';
import { SCOPE_ID, DB_BLOCK_ID, DOCUMENTS_BLOCK_ID } from './block-ids';
import { runMaintenanceChargeRun, runLateFeeSweep, chargeRunPeriodFromScheduledTime } from './payments/charges';
import { dispatchDueDateReminders } from './payments/reminders';
import type { PushAdapter } from './notifications/push-adapter';
import { FakePushAdapter } from './notifications/push-adapter';
import type { PaymentProvider } from './payments/payment-provider';
import { FakePaymentProvider } from './payments/fake-payment-provider';
import { initiatePayment, getPaymentStatus, ChargeNotPayableError, ChargeAlreadyLockedError } from './payments/payment-initiation';
import { linkDocumentToEntry, DocumentLinkError } from './finance/documents';
import { problemResponse, sendUnauthorized, sendNotFound, sendValidationError, ValidationError } from './http/problem-response';
import { registerBookRoutes } from './finance/books-routes';
import { registerMemberRoutes } from './members/members-routes';
import { registerProjectRoutes } from './projects/projects-routes';
import { registerProjectCommitteeRoutes } from './projects/committees-routes';
import { registerEmployeeRoutes } from './employees/employees-routes';
import { registerAssetRoutes } from './assets/assets-routes';
import { registerOwnershipRoutes } from './assets/ownerships-routes';
import { registerMeOwnershipRoutes } from './assets/me-ownerships-routes';
import { registerPcAssetRoutes } from './assets/pc-assets-routes';
import { registerInvoiceApprovalRoutes } from './vendors/invoice-approvals-routes';
import { registerInvoicePaymentRoutes } from './vendors/invoice-payments-routes';
import { registerEcInvoiceRoutes } from './vendors/ec-invoices-routes';
import { registerDocumentRoutes } from './documents/documents-routes';
// STR-041 code review: no HTTP surface of its own -- imported for its
// module-load side effect (registering vacateRolesOnStatusChange with
// members-api.ts's memberStatusTransitionListeners). Without this import,
// role-assignments.ts is never pulled into the running app's import graph
// and AC2 (suspension/cessation vacates held roles) silently doesn't fire
// outside the test suite that happens to import it directly.
import './members/role-assignments';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

// Estatly deploys one stack per society — single scope, no tenancy machinery,
// no society_id anywhere. The society is a deployment concern (EST-Deploy).
const scope = new Scope(SCOPE_ID);

// The two stateful Blocks, fixed from commit one (IDs are immutable — see
// block-ids.ts). Other mapped Blocks (AuthCognito, CronJob, AsyncJob,
// EmailClient, AppSetting, Logger/Metrics/Dashboard) join when their consuming
// stories arrive — no speculative declarations.
export const db = new Database(scope, DB_BLOCK_ID);
export const documents = new FileBucket(scope, DOCUMENTS_BLOCK_ID);

// STR-005: the walking-skeleton endpoint — proves the full delivery loop
// (contract, handler, tests, CI) before any domain story starts. Served
// through RawRoute, the STR-003-decided mechanism for the Admin/Mobile REST
// surfaces. Matches the mobile OpenAPI's GET /health (est-spec).
new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/v1/health',
  handler: async (ctx) => {
    ctx.response.send({ status: 'ok' });
  }
});

// STR-024: the Admin API book-read surface — GET /v1/books/{book}/entries
// and GET /v1/books/{book}/entries/{entryId}, serving the STR-023 book
// projections over the journal.
registerBookRoutes(scope, db);

// STR-025: link a scanned document (identified by its FileBucket path — the
// full document registry is E12, M3, not yet built) to a ledger entry.
// `book` is accepted for URL shape parity with the other /v1/books/{book}
// endpoints (not yet built) but isn't otherwise consulted — the link itself
// only depends on the entry.
new RawRoute(scope, 'link-book-entry-document', {
  method: 'POST',
  path: '/v1/books/{book}/entries/{entryId}/documents',
  handler: async (ctx) => {
    const { entryId } = ctx.request.params;
    const body = await ctx.request.json();
    const documentId: string = body?.document_id ?? '';
    try {
      const link = await linkDocumentToEntry(db, documents, entryId, documentId);
      ctx.response.status = 201;
      ctx.response.send({
        document_id: link.documentId,
        file_name: link.fileName,
        linked_at: link.linkedAt,
      });
    } catch (e: unknown) {
      if (e instanceof DocumentLinkError) {
        ctx.response.status = e.code === 'already_linked' ? 409 : 404;
        ctx.response.send({ error: { code: e.code, message: e.message } });
        return;
      }
      throw e;
    }
  }
});

// STR-031: the Admin API member and project CRUD surfaces — the M1
// registries ownerships, charges, and governance roles hang off.
registerMemberRoutes(scope, db);
registerProjectRoutes(scope, db);

// STR-043: the project committee (PC) sub-resource of a project -- appointed
// and dissolved by the EC, replacing the whole composition per call.
registerProjectCommitteeRoutes(scope, db);

// STR-042: employee records, capability designation, and salary posting to
// the Expense Ledger through the E03 journal engine.
registerEmployeeRoutes(scope, db);

// STR-051: the asset registry -- first-class entity existing before/without
// any ownership. STR-053 builds allotment on it; STR-057 builds
// visibility-scoped reads.
registerAssetRoutes(scope, db);

// STR-053: ownership allotment via asset_id -- creating an ownership is the
// sole writer of an asset's status/current_ownership_id.
registerOwnershipRoutes(scope, db);

// STR-063: run-summary observability for the charge run -- raised/skipped
// counts surface duplicate triggers (Lambda retries, duplicate EventBridge
// triggers, manual re-runs) for operational visibility.
const chargeRunLog = new Logger(scope, 'charge-run-log');
const chargeRunMetrics = new Metrics(scope, 'charge-run-metrics');

// STR-067: the due-date reminder push dispatch's adapter -- the real
// provider joins with the mobile milestone (E16/E17); swapping it in is a
// one-line change here, no run-logic edit needed (AC4).
const dueDateReminderAdapter: PushAdapter = new FakePushAdapter();

// STR-092: the payment initiation provider -- the real RazorpayTestModeAdapter
// needs AppSetting-sourced credentials no story has wired yet (STR-091's own
// precedent note), so this stays the fake test double until a later story
// wires the real adapter in. Swapping it in is a one-line change here.
const paymentProvider: PaymentProvider = new FakePaymentProvider();

// STR-061: the scheduled maintenance charge run -- monthly, first-of-month
// at 03:00 IST (this repo's established IST convention, aws-blocks/finance/
// financial-year.ts). Raises one `maintenance` charge per accruing
// (active/suspended) member's owned asset for the period the run fires in.
new CronJob(scope, 'maintenance-charge-run', {
  schedule: 'cron(0 3 1 * ? *)',
  timezone: 'Asia/Kolkata',
  description: 'Monthly maintenance charge run',
  handler: async (event) => {
    const { periodKey, dueDate } = chargeRunPeriodFromScheduledTime(event.scheduledTime);
    const raisedCharges = await runMaintenanceChargeRun(db, periodKey, dueDate, { log: chargeRunLog, metrics: chargeRunMetrics });
    // STR-065: the overdue sweep inside the same scheduled run -- raises
    // per-society-configured late fees for charges past their grace period.
    await runLateFeeSweep(db, periodKey, dueDate, { log: chargeRunLog, metrics: chargeRunMetrics });
    await dispatchDueDateReminders(db, dueDateReminderAdapter, raisedCharges);
  },
});

// STR-057: role-scoped asset visibility -- the mobile member's own
// ownerships (with embedded asset detail) and the PC's project-scoped
// registry read.
registerMeOwnershipRoutes(scope, db);
registerPcAssetRoutes(scope, db);

// STR-092: the mobile self-service payment-initiation surface -- locks the
// named due charges and returns a provider-neutral payment intent for the
// gateway SDK. Caller identity comes from the same X-Actor-Member-Id stub
// header registerMeOwnershipRoutes established; Idempotency-Key is required
// by the Mobile Public API's conventions table for this endpoint specifically.
new RawRoute(scope, 'initiate-payment', {
  method: 'POST',
  path: '/v1/me/payments',
  handler: async ctx => {
    const memberId = ctx.request.headers.get('X-Actor-Member-Id');
    if (!memberId) {
      sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
      return;
    }
    // Idempotency-Key presence check (422) -- presence-only, same as
    // employees-routes.ts's record-salary-payment; the dedupe/replay logic
    // itself lives in initiatePayment.
    const idempotencyKey = ctx.request.headers.get('Idempotency-Key');
    if (!idempotencyKey) {
      sendValidationError(ctx, new ValidationError('Idempotency-Key header is required.'));
      return;
    }
    const body = await ctx.request.json();
    const chargeIds: string[] = body?.charge_ids ?? [];
    // charge_ids presence/non-empty check (422) -- the OpenAPI spec requires
    // `minItems: 1`; without this, an empty array vacuously passes
    // lockChargesForPayment's checks and creates a zero-charge, zero-amount
    // payment_intents row.
    if (chargeIds.length === 0) {
      sendValidationError(ctx, new ValidationError('charge_ids must contain at least one charge id.'));
      return;
    }
    // STR-093: paymentMethod drives convenience-fee itemization inside
    // initiatePayment (see aws-blocks/payments/convenience-fee.ts).
    //
    // FINDING (review, STR-093): the Mobile Public API's `/me/payments` POST
    // request schema (EST-Spec/okf-bundle/api/mobile/openapi.yaml) only
    // documents `charge_ids` -- there is no `payment_method` field a
    // spec-compliant client can send at all, so the server has no contractual
    // way to *learn* the real payment method. Validating it here (rather than
    // defaulting an unset/garbage value into the fee-charging branch, which
    // silently overcharges every UPI payment once a society configures a
    // nonzero convenience-fee rate) closes the money-correctness hole, but it
    // does not resolve the underlying spec gap -- EST-Spec needs a
    // `payment_method` field added to this request schema (gate-G7,
    // out of scope for this fix) before a real client can pass this check.
    const paymentMethod = body?.payment_method;
    if (paymentMethod !== 'upi' && paymentMethod !== 'card' && paymentMethod !== 'netbanking') {
      sendValidationError(ctx, new ValidationError("payment_method is required and must be one of 'upi', 'card', 'netbanking'."));
      return;
    }
    try {
      const result = await initiatePayment(db, paymentProvider, memberId, chargeIds, paymentMethod, idempotencyKey);
      ctx.response.status = 201;
      ctx.response.send({
        payment_id: result.paymentId,
        amount: result.amount,
        provider: result.provider,
        provider_params: result.providerParams,
      });
    } catch (e: unknown) {
      if (e instanceof ChargeNotPayableError) {
        ctx.response.status = 422;
        ctx.response.send(problemResponse('charge_not_payable', e.message));
        return;
      }
      if (e instanceof ChargeAlreadyLockedError) {
        // 409, not sendConflictError -- that helper hardcodes the generic
        // `conflict` code, but the Mobile API's Error schema for this case
        // uses `charge_already_locked`.
        ctx.response.status = 409;
        ctx.response.send(problemResponse('charge_already_locked', e.message));
        return;
      }
      throw e;
    }
  },
});

// STR-093: the read-only status-poll surface -- success/failure is only ever
// set server-side from the gateway webhook (STR-094), so this route has no
// request body at all and no code path by which a client could transition
// the stored status (T-U3).
new RawRoute(scope, 'get-payment-status', {
  method: 'GET',
  path: '/v1/me/payments/{paymentId}',
  handler: async ctx => {
    const memberId = ctx.request.headers.get('X-Actor-Member-Id');
    if (!memberId) {
      sendUnauthorized(ctx, 'X-Actor-Member-Id header is required.');
      return;
    }
    const { paymentId } = ctx.request.params;
    const result = await getPaymentStatus(db, memberId, paymentId);
    if (!result) {
      sendNotFound(ctx, 'Payment not found.');
      return;
    }
    ctx.response.send({
      payment_id: result.paymentId,
      amount: result.amount,
      status: result.status,
      charge_ids: result.chargeIds,
      created_at: result.createdAt,
      completed_at: result.completedAt,
      failure_reason: result.failureReason,
    });
  },
});

// STR-083: two-phase invoice sign-off -- verify (designated-verifier) then
// EC-subset majority approve (designated-approver).
registerInvoiceApprovalRoutes(scope, db);

// STR-086: E09's capstone -- records payment against an approved invoice
// (finance-recorder), posting to the Expense Ledger + chosen Bank/Cash Book
// and linking the invoice's scanned document to the posted entry.
registerInvoicePaymentRoutes(scope, db, documents);

// STR-085: the Mobile Public API's EC approval inbox -- thin route adapters
// over the same invoice-approvals.ts functions the admin surface above uses,
// so the two can never disagree on workflow state or audit trail.
registerEcInvoiceRoutes(scope, db, documents);

// STR-111: the document registry -- registration with a presigned upload
// URL, and reads (metadata + presigned download) with lazy checksum/size
// verification from the real uploaded bytes. Reuses the shared `documents`
// FileBucket STR-025 already wired -- no second bucket.
registerDocumentRoutes(scope, db, documents);
