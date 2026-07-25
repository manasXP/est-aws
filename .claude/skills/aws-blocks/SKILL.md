---
name: aws-blocks
description: "Build the Estatly backend with AWS Blocks — the infrastructure-from-code toolkit where each Block (Database, FileBucket, AuthCognito, CronJob, AsyncJob, EmailClient, AppSetting, Logger/Metrics/Dashboard, etc.) bundles cloud resources, a Lambda runtime, and a local implementation in one npm package. Use when scaffolding, building, running locally, or deploying the est-aws Blocks app; when writing the aws-blocks/index.ts IFC layer; when choosing or wiring Blocks; when writing Vitest tests against Blocks' local implementations; or when the user mentions AWS Blocks, @aws-blocks, blocks-app, the est-aws repo, or the Estatly backend stack."
---

# AWS Blocks (Estatly)

AWS Blocks is a backend toolkit for building full-stack applications on AWS. Each **Block** is a self-contained npm package that bundles three things behind one API: the cloud resources, the production runtime (AWS SDK in **Lambda**), and a local implementation that runs with no AWS account. The same line of code — e.g. `new Database(scope, 'db')` — becomes an in-process PGlite locally, an Aurora Serverless v2 cluster at deploy time, and an SDK call in production. You don't change code between contexts.

Docs: https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html · Source: https://github.com/aws-devtools-labs/aws-blocks

This copy of the skill is adapted for **Estatly** (`est-aws` repo). Where the generic Blocks guidance and the Estatly architecture doc disagree, the Estatly doc wins: [[EST-Spec/okf-bundle/architecture/aws-blocks-backend|AWS Blocks Backend]] (stack summary: [[ESTx-Glance/TECHSTACK|TECHSTACK]]).

## When to use this skill

- Scaffolding the Estatly Blocks app or adding Blocks to it.
- Writing or editing the IFC layer (`aws-blocks/index.ts`) — instantiating Blocks, wiring handlers.
- Choosing the right Block for a need (see the decision tables in `reference.md` — but check the Estatly block set below first; most choices are already made).
- Running locally (`npm run dev`), writing Vitest tests against the local implementations, sandbox testing, or deploying to AWS.
- Dropping into the CDK layer for resources that don't have a Block (for Estatly: possibly the REST ingress — see the open question below).

## Core mental model (read before writing code)

1. **Scope** — every Block is instantiated inside a `Scope`. The Block's full ID joins scope and block ID with a **hyphen** (verified v0.2.3: `new Database(scope, 'db')` under scope `estatly` → `fullId` `estatly-db`). IDs determine resource names.
2. **IFC layer** (`aws-blocks/index.ts`) — your single backend entry point. Instantiate Blocks and define your API here. Infrastructure is *derived from this code* — there are no separate IaC files.
3. **ApiNamespace** — Blocks' type-safe RPC where a TypeScript frontend imports and calls backend methods directly. **Estatly does not use this as its client contract**: all clients (admin panel, KMP mobile module) consume **contract-first REST** against the two OpenAPI surfaces ([[EST-Spec/okf-bundle/api/admin/public-api|Admin API]], [[EST-Spec/okf-bundle/api/mobile/public-api|Mobile Public API]]). Know what ApiNamespace is; don't reach for it as the product API.
4. **BlocksContext** — the per-request object passed into request handlers. Auth blocks read it (`auth.getCurrentUser(context)`). You never construct it.
5. **Conditional exports** — one `import` resolves to local impl / CDK construct / AWS SDK depending on context (dev, synth, Lambda). Automatic; never configured by hand.
6. **CDK layer** (`aws-blocks/index.cdk.ts`, optional) — escape hatch for raw CDK constructs and embedding into an existing CDK app. Estatly uses it for `Hosting` (admin panel + landing) and possibly for REST ingress.

> ⚠️ **Block IDs are immutable once deployed.** Renaming the second constructor arg deletes and recreates the AWS resource → **permanent data loss** for stateful Blocks (`Database`, `FileBucket`). Treat IDs as forever. Estatly fixes them early: `estatly-db`, `estatly-documents` (per the architecture doc).

## Estatly usage notes (load-bearing)

- **Single stack per society — no multi-tenancy.** One deployment, one data store, one Razorpay merchant account per society. No `society_id` columns, no tenancy machinery, no RLS in the schema. The `Scope` name carries the society (e.g. `estatly-<society>`); provisioning a new society is a repeatable deploy of the same IFC code. Fleet concerns (upgrading N stacks) live in EST-Deploy.
- **Region: `ap-south-1` (Mumbai).** Aurora Serverless v2, Cognito, and SES are available there; verifying the *full* Blocks set in the region is a build-time check.
- **Runtime: Lambda** (TypeScript). Backend code deploys to Lambda; scheduled and background work also runs on Lambda via `CronJob`/`AsyncJob`.
- **Block set actually used** (mapping ratified in the architecture doc):

| Estatly need | Block | AWS service |
| --- | --- | --- |
| System of record — members, ownerships, work orders, invoices, books of account; document-metadata search (Postgres `tsvector`) | `Database` | Aurora Serverless v2 (PGlite locally) |
| Scanned bills/vouchers/receipts/challans; society/project/member documents (presigned upload/download) | `FileBucket` | S3 |
| Auth — members, management, employees, vendors (MFA; role claims per governance spec) | `AuthCognito` | Cognito |
| Recurring charge runs, due-date reminders | `CronJob` | EventBridge + Lambda |
| Tally export, GST reports, Razorpay webhook reconciliation | `AsyncJob` | SQS + Lambda |
| Bills, receipts, approval notifications by email | `EmailClient` | SES |
| Config & secrets (gateway keys) | `AppSetting` | SSM Parameter Store |
| Observability | `Logger` / `Metrics` / `Dashboard` | CloudWatch |
| Admin panel + landing hosting (CDK layer) | `Hosting` | CloudFront + S3 |

- **Not used in v1:** `Agent`/`KnowledgeBase` (no AI features), `Realtime` (no live collaboration), `KVStore`/`DistributedTable` (relational store covers v1; add for caching only on measured need), `AuthBasic`/`AuthOIDC` (Cognito decided), `DistributedDatabase`.
- **Open question — REST ingress (M0 spike, epic E01):** can Blocks serve plain HTTP routes natively? If yes, the REST surfaces (and the Razorpay webhook endpoint) are Blocks-native; if not, they go through the **CDK escape hatch** (API Gateway + Lambda). Policy decided 2026-07-20; native support is a build-time verification item, not a blocker.
- **Testing (TDD is mandatory):** **Vitest** unit tests run against Blocks' **local implementations** — no AWS account, no mocks of AWS SDKs. Contract tests validate handlers against the OpenAPI specs in `EST-Spec/okf-bundle/api/`; ledger invariants (double-entry balance, GST rounding) are property-style unit tests. Test cases live in `EST-TCC/`.

## Quick start

Prerequisites: **Node.js ≥ 22**, **npm ≥ 10**, a TypeScript-aware editor. (Deploy only: AWS CLI v2 configured + CDK bootstrapped.)

```bash
npm create @aws-blocks/blocks-app@latest est-aws
cd est-aws && npm install
npm run dev          # http://localhost:3000 — fully local, no AWS account
```

Project shape:

```
est-aws/
├── aws-blocks/
│   ├── index.ts        # IFC layer: Blocks + request handlers (backend)
│   └── index.cdk.ts    # optional CDK escape hatch (Hosting; ingress if needed)
├── src/                # frontend workspace (admin panel is its own concern)
└── package.json
```

Minimal Estatly-shaped IFC layer sketch:

```ts
// aws-blocks/index.ts
import { Scope, Database, FileBucket, AuthCognito } from '@aws-blocks/blocks';

const scope = new Scope('estatly-<society>');   // Scope carries the society

const db = new Database(scope, 'db');            // Aurora Serverless v2; ID is forever
const documents = new FileBucket(scope, 'documents');
const auth = new AuthCognito(scope, 'auth');
// + CronJob (charge runs), AsyncJob (Tally/GST/webhooks), EmailClient, AppSetting,
//   Logger/Metrics/Dashboard — see reference.md
```

## Running & deploying

```bash
npm run dev               # local, no AWS — data persists in ./.bb-data/
npm run sandbox           # fast ephemeral deploy to real AWS (Lambda hot-swap)
npm run sandbox:destroy   # tear down the sandbox
npm run deploy            # full CDK/CloudFormation deploy (staging/prod)
npm run destroy           # remove all deployed resources
```

One-time AWS setup before the first deploy: configure AWS CLI v2 (`aws sts get-caller-identity` to verify), then bootstrap CDK: `npx cdk bootstrap aws://ACCOUNT_ID/ap-south-1` (once per account+region).

## Working guidance for Claude

- **Verify the SDK surface against the docs/source before asserting exact signatures.** AWS Blocks is new and evolving; method names in `reference.md` are grounded in the official guide but confirm with https://github.com/aws-devtools-labs/aws-blocks (or the per-Block reference pages) when precision matters. Use WebFetch/context7 rather than guessing.
- Keep all Blocks in the IFC layer; don't scatter instantiations.
- Don't hand-write IaC — derive infra from Block instantiations. Reach for the CDK layer only when no Block fits (for Estatly: `Hosting`, and REST ingress if the M0 spike says Blocks can't serve plain HTTP).
- Never rename a stateful Block's ID on a deployed app (data loss). Call this out if the user asks for a rename.
- Prefer local `npm run dev` for iteration and Vitest against local implementations for TDD; use `sandbox` only to test behavior that genuinely differs on real AWS (query perf, IAM boundaries, Cognito flows).
- Follow the Estatly architecture doc over generic Blocks defaults: no ApiNamespace-as-client-contract, no multi-tenancy, region `ap-south-1`.
