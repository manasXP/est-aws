# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`est-aws` is the backend implementation for **Estatly**, a single-society housing-society management SaaS. It's built on **AWS Blocks** — a framework where backend logic, infra (CDK), and local mocks are defined together in one directory (`aws-blocks/`) and deployed unchanged to AWS.

This repo is one of several under the `manasXP` org that make up the Estatly project, attached here as git submodules for cross-reference:
- `est-spec/` — specifications (OKF bundle: domain model, architecture, API contracts) — the source of truth for *what* to build
- `est-tcc/` — test cases (`TC-*`), the executable-spec seed; TDD is mandatory, so implementation work should trace back to a case here
- `est-deploy/` — deployment docs (provisioning, environment/secrets, release/rollback) — describes the one-stack-per-society production model
- `est-pm/` — epics/sprints/stories driving the build; `est-pm/Stories/` has the current story (e.g. `STR-001`) this repo's commits reference

When picking up work, check `est-pm` for the active story and `est-tcc` for the cases it must satisfy before writing code.

## Commands

```bash
npm run typecheck        # tsc --noEmit — run after every code change
npm test                 # typecheck + vitest run (the actual test command; despite what generic
                          # AWS Blocks docs say, there is no `test:e2e` script in this repo)
npm run dev               # local dev server (long-running — background it); backend runs as in-memory
                          # mocks, data persists to .bb-data/ (delete to reset), no AWS account needed
npm run sandbox           # deploy to a real AWS sandbox stack, cdk watch --hotswap keeps it in sync
npm run sandbox:destroy   # tear down the sandbox stack
npm run sandbox:console   # open the sandbox stack's AWS console
npm run deploy            # full production deploy
npm run destroy           # tear down the production stack
npm run cleanup           # aws-blocks/scripts/cleanup.ts
```

Run a single test file: `npx vitest run test/scaffold.test.ts`.

The local test loop must stay AWS-free: `test/scaffold.test.ts` strips all `AWS_*` env vars in `beforeAll` before exercising the Blocks local mocks, so a passing run proves no real AWS calls happened.

## Architecture

- **`aws-blocks/index.ts`** — the entire backend: Blocks are composed here (`Scope`, `Database`, `FileBucket`, `ApiNamespace`, etc.) and anything meant to be callable from a frontend must be `export`ed. No frontend exists yet in this template; a future one would `import { api } from 'aws-blocks'` for fully-typed calls with no manual RPC/fetch code.
- **`aws-blocks/block-ids.ts`** — single source of truth for stateful Block IDs (`SCOPE_ID`, `DB_BLOCK_ID`, `DOCUMENTS_BLOCK_ID`). **These are immutable once deployed** — renaming one deletes and recreates the underlying AWS resource (permanent data loss for `Database`/`FileBucket`). Never edit existing values here; only add new ones.
- **`aws-blocks/index.cdk.ts`** — CDK entrypoint (`npx tsx -C cdk aws-blocks/index.cdk.ts`, wired via `cdk.json`). Builds the `BlocksStack`, and in sandbox mode relaxes removal policies/deletion protection so `sandbox:destroy` can fully tear down.
- **`aws-blocks/index.handler.ts`** — Lambda entrypoint, thin wrapper via `createLambdaHandler`.
- **Deployment model**: Estatly deploys **one CDK stack per society** — a single `Scope`, no tenancy machinery, no `society_id` anywhere in this repo's code. Multi-society concerns (provisioning, per-society config) live in `est-deploy`, not here.
- **Stack naming**: derived from `stackId` in `.blocks/config.json`. Production stacks are `<stackId>-prod`; sandbox stacks are `<stackId>-<username>-<random>` (per-machine ID in `.blocks-sandbox/sandbox-id.txt`, gitignored) so multiple developers can share an AWS account without colliding.
- **Transport**: the frontend/backend boundary is JSON-RPC 2.0 over a single endpoint (`POST /aws-blocks/api`), handled entirely by the framework — never construct or curl these payloads except for connectivity troubleshooting.

For anything about *which* Building Block to use or its API, read `node_modules/@aws-blocks/blocks/README.md` and `node_modules/@aws-blocks/blocks/docs/index.md` (decision tree) — hovering a block in the IDE also surfaces its docstring.

## Rules

- Use Building Blocks for all persistence and cloud abstractions — never local files, in-memory arrays, or ad hoc databases outside the Blocks system.
- Every `ApiNamespace` method is public with no auth by default — gate with `auth.requireAuth`/`requireRole` explicitly; the local mock does not enforce this either.
- Follow the TDD flow from `est-tcc`: a case there becomes the failing test that opens the cycle for any new backend behavior.
- Never commit or push directly to `main`; work on a branch and open a PR. See [`BRANCHING.md`](./BRANCHING.md) for branch naming (`story/STR-NNN`, `fix/`, `chore/`, `spike/`) and merge conventions.
