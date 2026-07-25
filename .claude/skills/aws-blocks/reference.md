# AWS Blocks — Block reference (Estatly)

Companion to `SKILL.md`. Grounded in the AWS Blocks Developer Guide
(https://docs.aws.amazon.com/blocks/latest/devguide/) and the source repo
(https://github.com/aws-devtools-labs/aws-blocks). AWS Blocks is new and moving
quickly — **confirm exact constructor options and method signatures against the
per-Block reference page or the package source before relying on them.** Each
Block lives at `packages/<bb-*>` in the source repo.

Ordering below follows the **Estatly block set** (ratified in
[[EST-Spec/okf-bundle/architecture/aws-blocks-backend|AWS Blocks Backend]]); Blocks Estatly
does not use are summarized at the end. Where this file and the Estatly
architecture doc disagree, the architecture doc wins.

## Concepts recap

- **Block** — npm package = cloud resource + Lambda runtime + local impl, one API.
- **Scope** — namespace; full Block ID joins scope and block ID with a hyphen (`scopeName-blockId`, verified v0.2.3). IDs are immutable once deployed. Estatly: the Scope carries the society (`estatly-<society>`); stateful IDs fixed early (`estatly-db`, `estatly-documents`).
- **IFC layer** — `aws-blocks/index.ts`; infra derived from Block instantiations.
- **ApiNamespace** — Blocks' type-safe RPC (frontend imports `api` directly). **Not Estatly's client contract** — clients consume contract-first REST against the Admin/Mobile OpenAPI specs; ingress mechanism is the M0 spike (Blocks-native HTTP vs CDK API Gateway + Lambda).
- **BlocksContext** — per-request object passed to handlers; auth blocks consume it.
- **Conditional exports** — same import → local impl / CDK construct / AWS SDK per context.
- **CDK layer** — `aws-blocks/index.cdk.ts`, optional escape hatch (see end of this file).
- **Local data** — persisted under `./.bb-data/` (one subdir per Block). Vitest runs against these local implementations — no AWS account, no SDK mocks.

---

## Estatly core blocks

### Database — Aurora Serverless v2 (PGlite locally)

Estatly's **system of record**: members, ownerships, work orders, invoices, and the **books of account** (double-entry journal). Relational + ACID transactions are non-negotiable for the ledgers; document-metadata search uses Postgres full-text (`tsvector`) in the same database — no separate search infrastructure.

Full PostgreSQL via the **Kysely** query builder: type-inferred SQL, parameterized queries, single-row lookups, ACID transactions, foreign keys, migrations, Row Level Security. Use the `db pull` command to import an existing schema. PGlite (WASM Postgres) runs in-process locally.

Estatly notes:
- Single-society deployment — **no tenancy columns and no RLS** in the schema.
- Ledger invariants (double-entry balance, gapless receipt series, GST rounding on exact decimal strings) are enforced in migrations/handlers and pinned by property-style Vitest tests against PGlite.
- Block ID is `estatly-db` — never rename (data loss).

### FileBucket — S3

Scanned bills, vouchers, receipts, challans, and society/project/member documents. Store by path, **presigned upload/download URLs**, list-by-prefix, optional versioning. Files stored under `.bb-data/` locally. Wrap an existing bucket with `FileBucket.fromExisting(bucketName)`.

Estatly notes: one registry serves both ledger-entry links and the document library ([[EST-Spec/okf-bundle/specifications/document-management|Document Management]]). Metadata lives in `Database` (searchable); the bucket holds only bytes. Block ID `estatly-documents` — never rename.

### AuthCognito — Cognito

Production auth for members, management, employees, and vendors. Social sign-in, MFA (SMS/TOTP/email OTP), user-pool groups, SAML, passkeys, account recovery. Provisions a Cognito User Pool on AWS; simulated locally.

Shares the common auth interface (`requireAuth`, `getCurrentUser`, `createApi`) with the other auth blocks. Estatly notes: role claims follow [[EST-Spec/okf-bundle/specifications/governance-and-roles|Governance & Roles]]; Cognito is available in `ap-south-1`. Local simulation covers unit/contract tests; real Cognito flows are a `sandbox` concern.

### CronJob — EventBridge + Lambda

Define a handler plus a **cron expression or rate schedule**; runs automatically at the interval. Uses Node.js timers locally.

Estatly notes: monthly/quarterly **maintenance-fee charge runs** and due-date reminders ([[EST-Spec/okf-bundle/specifications/payments|Payments]]). Charge-run logic must be idempotent per period — the handler is where the charge-run invariants from TC-PAY get exercised.

### AsyncJob — SQS + Lambda

Define a handler that processes each job payload; submit work that runs outside the request lifecycle. Fire-and-forget to the caller, with **automatic retries on failure**. Handlers run in-process locally.

Estatly notes: **Tally export**, **GST report generation**, and **Razorpay payment-webhook reconciliation** — long-running/retryable background work. Webhook reconciliation must be idempotent under SQS redelivery (settlement applied at most once per payment).

### EmailClient — SES

Configure a from-address; send text or HTML bodies. **Batch send up to 50 emails per call.** Locally it **captures emails and logs them to the console** instead of sending — assert on captured output in Vitest.

Estatly notes: bills, receipts, and approval notifications by email. SES is available in `ap-south-1`; production sending requires moving the account out of the SES sandbox (a provisioning-runbook step, EST-Deploy).

### AppSetting — SSM Parameter Store

A single typed config value or secret, readable/updatable at runtime (no env-var boilerplate). Mark `secret: true` to store as a **SecureString**. In-memory locally.

Estatly notes: Razorpay merchant/gateway keys (one merchant account per society) and other per-society config live here, not in code or env files.

### Observability — Logger / Metrics / Dashboard (CloudWatch)

| Block | Best for | Avoid when |
| --- | --- | --- |
| `Logger` | structured JSON logging with correlation IDs and levels | you need numeric aggregation/alerting (use `Metrics`) |
| `Metrics` | custom metrics with dimensions for filtering/aggregation | you only need request-level tracing |
| `Dashboard` | real-time ops views combining metrics/logs/alarms | you have no `Metrics`/`Logger` blocks yet (add those first) |

- **`Metrics`** — CloudWatch (Embedded Metric Format, zero-latency emission). Emit named data points with **dimensions**; supports **child emitters** with merged dimensions. Writes to console locally.
- **`Logger`** — CloudWatch Logs. Structured JSON at **debug/info/warn/error** levels with attachable metadata; correlates to API Gateway request IDs on AWS. Writes to console locally.
- **`Dashboard`** — CloudWatch Dashboard auto-generated from your `Metrics` definitions (no manual widgets). **No-op locally.**

(`Tracer`/X-Ray exists in the toolkit but is not in the ratified Estatly set; add only on demonstrated need.)

### Hosting — CloudFront + S3 (CDK layer only)

Frontend deployment with SSR. Import from `@aws-blocks/blocks/cdk` and use in the **CDK layer** (`aws-blocks/index.cdk.ts`), not the IFC layer. Auto-detects framework (Next.js, Nuxt, Astro, or SPA) and provisions: CloudFront + S3 origin, Lambda compute for SSR, optional WAF, monitoring dashboards, DNS, custom domains, and **skew protection**. Included automatically on `npm run deploy`; **not deployed for `npm run sandbox`**. Locally your frontend is served by the dev server at `:3000` with hot reload.

Estatly notes: serves the **admin panel** (Next.js) and the **landing site** (static export from the same toolchain; no backend consumption).

---

## Blocks evaluated and NOT used in Estatly v1

Keep these in mind so you don't re-invent them, but do not add them without a decision recorded in the architecture doc:

- **`KVStore`** (DynamoDB) / **`DistributedTable`** (DynamoDB + GSIs) — the relational store covers v1; add for caching only on measured need.
- **`DistributedDatabase`** (Aurora DSQL) — optimistic concurrency can fail at commit; wrong fit for the ledger, and `Database` is decided.
- **`AuthBasic`** / **`AuthOIDC`** — Cognito decided; the shared auth interface means a swap is possible but is an architecture decision, not a convenience.
- **`Realtime`** (API Gateway WebSocket) — no live-collaboration requirement.
- **`Agent`** / **`KnowledgeBase`** (Bedrock) — no AI features in the brief.

---

## CDK layer (escape hatch)

`aws-blocks/index.cdk.ts` — optional. Use for resources without a Block, custom domains/VPC, or embedding Blocks into an existing CDK app. If absent, AWS Blocks generates a default CDK app from the IFC layer.

Estatly uses the CDK layer for `Hosting`, and — pending the **M0 ingress spike (E01)** — possibly for the REST surface: if Blocks cannot serve plain HTTP routes natively, the Admin/Mobile REST APIs and the **Razorpay webhook endpoint** are wired here as **API Gateway + Lambda**.

```ts
// aws-blocks/index.cdk.ts
import * as cdk from 'aws-cdk-lib';
import { BlocksStack } from '@aws-blocks/blocks/cdk';

const app = new cdk.App();
const stack = await BlocksStack.create(app, 'estatly-<society>', {
  backendHandlerPath: './index.handler.ts',
  backendCDKPath: './index.ts',
});
// e.g. API Gateway REST ingress + webhook route here, if the M0 spike
// concludes Blocks-native HTTP is unavailable.
```

---

## Deployment

| Command | What it does |
| --- | --- |
| `npm run dev` | full local app on :3000, no AWS, data in `./.bb-data/` |
| `npm run sandbox` | fast ephemeral deploy to real AWS (Lambda hot-swap), isolated per developer |
| `npm run sandbox:destroy` | tear down sandbox |
| `npm run deploy` | full CDK/CloudFormation deploy (staging/prod) |
| `npm run destroy` | remove all deployed resources |

One-time AWS setup:
1. AWS CLI v2 configured (IAM Identity Center recommended); verify with `aws sts get-caller-identity`.
2. Bootstrap CDK once per account+region: `npx cdk bootstrap aws://ACCOUNT_ID/ap-south-1`.

Estatly notes:
- **Region `ap-south-1` (Mumbai)** for every society stack. Aurora Serverless v2, Cognito, and SES are confirmed available; verify the full Blocks set in-region at build time.
- **One stack per society**: provisioning a society = deploying the same IFC code under a new `estatly-<society>` scope (with its own Razorpay merchant keys in `AppSetting`). Fleet operations — upgrading N society stacks, per-society cost tracking — are governed by EST-Deploy (`fleet.yaml`, provisioning runbook, release & rollback).
- Production IAM: the guide recommends admin access only for getting started; scope a least-privilege policy for society stacks before pilot go-live (M5).
- Outside the per-society stack sits the vendor-owned [[EST-Spec/okf-bundle/architecture/society-directory|Society Directory]] — the one multi-society component, resolving invite links/codes to a deployment's endpoints; registering with it is a provisioning-runbook step, not part of this app.

## Testing (TDD)

- **Vitest** against Blocks' **local implementations**: `Database` → PGlite, `FileBucket` → `.bb-data/` files, `EmailClient` → console capture, `CronJob`/`AsyncJob` → in-process handlers, `AuthCognito` → local simulation. No AWS account and no AWS SDK mocks in unit tests.
- **Contract tests** validate REST handlers against the OpenAPI specs in `EST-Spec/okf-bundle/api/` (Admin + Mobile surfaces).
- **Property-style tests** pin ledger invariants (double-entry balance, GST rounding, gapless receipts).
- Use `sandbox` only for behavior that genuinely differs on real AWS: IAM boundaries, real Cognito flows, Aurora query performance, API Gateway specifics.

## Supported client platforms

Web (Next.js, React, etc.), native mobile (Swift, Kotlin), desktop. For Estatly the mobile clients are native SwiftUI/Compose shells over a shared **KMP module** (Ktor client), which consumes the REST contract — Blocks' backend-to-client type inference does not extend to them; the OpenAPI specs are the contract.

## Related AWS tooling

AWS Blocks apps **are** CDK apps — any CDK construct composes with Blocks. Backend code deploys to Lambda; HTTP/WebSocket ingress via API Gateway.
