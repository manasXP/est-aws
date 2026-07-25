---
name: story-tdd-knowledge
description: >
  Durable Estatly conventions and invariants for implementing a story test-first:
  test-layer vocabulary, TC-ID citation rules, the domain invariants that must
  never be violated in a diff, and the est-aws repo facts. Read-only reference
  loaded alongside the story-tdd loop. Load when implementing any STR-NNN story,
  writing Estatly tests, or reviewing an Estatly story PR.
---

# story-tdd-knowledge

Read-only reference for the `story-tdd` loop. Nothing here changes between runs.
If you find yourself wanting to record progress, that belongs in
`loops/story-tdd/STATE.md`.

---

## The acceptance rule

**`TC-<AREA>-<NNN>` cases in `EST-TCC/` ARE the acceptance material.** They are
written from the specs *before* code exists — the executable-spec seed.

- A story's Red tests **cite** existing TC IDs: `covers TC-FIN-001`.
- **Never rewrite TC case text into a story or a test name.** Cite the ID.
- Add `T-U*` / `T-C*` / `T-P*` / `T-E*` IDs **only** for genuine gaps the TC
  cases do not cover.
- A case with no spec backing is a scope bug — **fix the spec first** (gate G7),
  do not paper over it in a test.

Areas: `FIN` · `PAY` · `VEN` · `MEM` · `AST` · `TKT` · `COM` · `DOC` · `MOB`.

## Test layers

| Layer | Toolchain | Runs against |
|---|---|---|
| `BE-U` | Vitest | Backend units on Blocks' local implementations |
| `BE-C` | Vitest contract | Handlers vs the OpenAPI docs in `EST-Spec/okf-bundle/api/` |
| `BE-P` | Vitest property | Ledger invariants — balance, GST rounding, gapless series |
| `KMP` | `kotlin.test` / SQLDelight in-memory / Ktor `MockEngine` | Shared mobile logic |
| `WEB` | Vitest + React Testing Library | Admin panel |
| `E2E` | Playwright | Admin panel core flows |
| `IOS` / `AND` | XCTest / Compose UI | Thin shells only — logic cases belong in `KMP` |

All 30 currently-seeded stories are `repo: est-aws`, so in practice: `BE-U`,
`BE-C`, `BE-P`.

## The design-source rule (UI stories: `WEB` · `E2E` · `IOS` · `AND`)

Parallel to the TC-ID rule: **the Pencil designs ARE the visual acceptance
material.** Before implementing any story with a UI test layer, load the
`est-design-system` skill and open the screen's frame in the matching `.pen`
file (`EST-Design/Pen.dev/EST-admin.pen` / `EST-mobile.pen`, via the pencil
MCP — never Read/Grep).

- Build to the screen's `.pen` frame; PNG references in `EST-Design/Pen.dev/exports/`.
- Every color/font/radius comes from the token set in
  `EST-Design/design-tokens.md` — **no raw hex values in a UI diff**.
- Screen not in the `.pen` file → that's a scope bug: stop and surface it
  (same posture as gate G7), don't invent a design.

## Writing rules

- **Test behavior, not implementation.** Name observable outcomes — status
  codes, ledger postings, states — never internal functions.
- **One assertion focus per case.** A flow with five checks is five cases.
- **Negative cases are first-class.** Every 403/409/422 and every forbidden
  transition in `ESTx-Glance/WORKFLOW.md` gets a case.
- **Money is exact**: decimal strings (`"1250.00"`), matching the contracts.

---

## Invariants — a diff violating any of these is wrong, even if tests pass

1. **Single society per deployment.** No tenancy machinery anywhere — no
   `society_id` column, no multi-tenant scoping, ever. One stack and one data
   store per society.
2. **Money is exact decimal strings.** `"1250.00"` in, `"1250.00"` out. **No
   float arithmetic on money anywhere in the diff** — not in helpers, not in
   tests, not in fixtures.
3. **The journal is append-only.** Corrections are reversing entries, never
   mutations. The four books are *derived views* over the single double-entry
   journal, not independently maintained tables.
4. **Stateful Block IDs are immutable once deployed.** `estatly-db` and
   `estatly-documents` are fixed from commit one and test-guarded. Renaming one
   destroys data.
5. **Expand-contract migrations.** Never a destructive change in the same step
   as the expand. A contract step stops at gate G8.
6. **Local-first.** `npm test` must be green on a clean checkout with **no AWS
   account and no credentials**. A test that needs real AWS is a broken test.

## Minimality

Green means *the minimum implementation that passes*. No features beyond the
story, no abstractions for single-use code, no unrequested configurability, no
error handling for impossible states. If the `### Refactor` section does not
name it, do not do it in this story.

---

## est-aws repo facts

| | |
|---|---|
| Path / remote | `~/code/est-aws` → `manasXP/est-aws` |
| `npm test` | `tsc --noEmit && vitest run` — the CI gate |
| `npm run dev` | `tsx watch aws-blocks/scripts/server.ts`, local Blocks runtime |
| IFC layer | `aws-blocks/index.ts` — infrastructure-from-code, **no separate IaC** |
| Tests | `test/` |
| Toolchain | TypeScript strict, Vitest, esbuild, aws-cdk-lib, tsx |

**SDK finding on record (STR-001):** `fullId` joins scope and block ID with a
**hyphen** — `estatly-db`, `estatly-documents` — not the slash the specs
originally assumed. Findings like this are the loop's most valuable output:
record them in the story's `## Revision History` and the PR body so they feed
back into the specs.

## Story anatomy

Frontmatter: `id, type, epic, milestone, repo, status, points, spec_refs`.
Body, in order: `## User story` → `## Context` → `## TDD plan`
(`### Red` → `### Green` → `### Refactor`) → `## Acceptance criteria` →
`## Dependencies` → `## Definition of Done` → `## Revision History`.

Story IDs are decade-blocked by epic (E01 → STR-001…009, E02 → STR-011…019, …)
with gaps left for insertion. **Never renumber.**
