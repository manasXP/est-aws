---
name: story-tdd
description: >
  Self-running loop that drains the Estatly implementation-story queue by TDD.
  Trigger on: work the next story, run the story loop, implement STR-NNN,
  drain the backlog, continue the TDD loop. Picks the next unblocked story from
  EST-PM/Stories, writes its Red tests first in an isolated worktree, implements
  the minimum Green, refactors, proves red-then-green via a separate verifier,
  and opens a PR for human merge. One story per run.
---

# story-tdd

## Goal

**Exit predicate:** no story file in `EST-PM/Stories/M*/STR-*.md` has
`status: todo` whose upstream epics are all `done`.

Checkable without a model:

```bash
scripts/next-story.sh --count   # 0 unblocked todo stories => queue drained
```

When the predicate holds, the loop writes a final summary to the state file and
exits. Note the queue *grows*: M2–M5 stories are cut just-in-time when their
epic starts, so "drained" means drained-for-now, not finished-forever.

---

## Conventions (durable only — never write progress here)

This file is **read-only at runtime.** It carries logic, not state.

- **Never write progress, counters, story status, or results here.** All
  changing data belongs in `loops/story-tdd/STATE.md`.
- This file reloads from disk on every cold start; anything written here
  between runs silently disappears.
- Three state locations exist: `STATE.md` (cursor + audit log, this loop's
  execution ledger only), each artifact's `status:` frontmatter in `EST-PM`
  (a synced local mirror), and its **GitHub Issue** in `manasXP/est-aws`
  (open/closed + `status:in-progress`/`status:blocked`/`status:deferred`
  labels). **GitHub is the authority for status** — on any disagreement,
  GitHub wins and the frontmatter is corrected to match, never the reverse. A
  torn `STATE.md` is rebuilt by re-scanning the stories.
- Every status change for a story or epic goes through
  `scripts/set-status.sh <ID> <todo|in-progress|blocked|deferred|done>` — it
  updates the GitHub issue first, then the local `EST-PM` frontmatter file if
  one exists (some later-milestone artifacts only exist as GitHub issues
  today; that's fine, the script skips the frontmatter write). Never hand-edit
  a `status:` field or flip an issue's state/labels directly — always go
  through the script so the two stay in sync.
- Both writes use write-then-rename (`write tmp && mv tmp target`) so a crash
  cannot leave a half-written ledger.

---

## Fixed facts

| | |
|---|---|
| Story queue | `EST-PM/Stories/M*/STR-*.md` (vault, `EST-PM` git clone) |
| Target repo | `~/code/est-aws` — every story's `repo:` field, remote `manasXP/est-aws` |
| Test command | `npm test` = `tsc --noEmit && vitest run` |
| Acceptance material | `EST-TCC/` — `TC-<AREA>-<NNN>` cases. **Never rewrite TC text into a story or test; cite the ID.** |
| Load first | the `story-tdd-knowledge` skill (Estatly TDD conventions, invariants) |

---

## Pattern: ReAct + deterministic verifier

Each run handles **exactly one story**, then halts at the merge gate.

### 1. Read state

Load `loops/story-tdd/STATE.md`. If a story is `in-progress`, resume it rather
than picking a new one. If a story is `failed`, **halt** — gate G2 is open.

### 2. Discover the next story

Deterministic ordering, model-read veto:

- Order candidates by milestone (`M0` → `M5`), then STR number ascending. The
  decade-blocking in `EST-PM/Stories/README.md` already aligns numeric order
  with epic order, so this is a sound default.
- Take the lowest-numbered `status: todo` story.
- **Then read its `## Dependencies` prose.** It is written for humans
  ("E01 and E02 upstream"), not machines. If it names an upstream epic whose
  stories are not all `done`, skip this story, log the skip with the reason in
  `STATE.md`, and take the next candidate.
- If a story is skipped three runs in a row, run
  `scripts/set-status.sh STR-NNN blocked` and halt.

### 3. Act — in an isolated worktree

Mark the story taken before touching code:

```bash
scripts/set-status.sh STR-NNN in-progress
git -C ~/code/est-aws worktree add ../est-aws-STR-NNN -b story/STR-NNN
```

Read the story in full, plus every path in its `spec_refs:` and every
`TC-<AREA>-<NNN>` cited in its Red section. Then, **in this order** — the order
is what the verifier checks:

1. **Red.** Write only the tests from `### Red`. Cite TC IDs in test names
   exactly as the story does (`covers TC-FIN-001`). Add `T-U*/T-C*/T-P*/T-E*`
   IDs only for genuine gaps. Run `npx vitest run` and confirm they fail for
   the *intended* reason. Commit, touching **test files only**:
   `STR-NNN Red: <short description>`
2. **Green.** The minimum implementation that passes. No speculative
   abstraction, no unrequested configurability. Commit:
   `STR-NNN Green: <short description>`
3. **Refactor.** Only what the story's `### Refactor` names. Commit separately
   if non-trivial: `STR-NNN Refactor: <short description>`

### 4. Verify

```bash
.claude/skills/story-tdd/verifier STR-NNN ~/code/est-aws-STR-NNN
```

Exit 0 → passed. Exit 1 → **halt immediately**; do not retry silently. Write
the failure reason to `STATE.md` and open gate G2. On the third consecutive
failure for the same story, also run `scripts/set-status.sh STR-NNN blocked`
(budget table in `HUMAN-GATES.md`).

The verifier is a separate program and its **exit code is the only signal**.
Never substitute your own reading of the test output for its verdict, and never
edit the verifier to make a story pass — that is self-approval.

### 5. Open the PR — then stop

Push the branch and open a PR citing the story ID, its ACs, and the cited TC
IDs. **The loop does not merge.** Gate G3 is unconditional.

### 6. Write state

Update `STATE.md`: story row → `awaiting-merge`, iteration count, timestamp,
PR URL. Only *after* the verifier passed — never before.

### 7. Check exit predicate and budget

Both, every iteration. Then stop: one story per run.

---

## After the human merges

The merge is the signal to finish the story's bookkeeping. On the next run,
before picking a new story, for any `awaiting-merge` row whose PR is merged:

- Run `scripts/set-status.sh STR-NNN done` — closes the GitHub issue and sets
  the frontmatter to `status: done`.
- Append a `## Revision History` row: date, `Claude`, what was done, the commit
  SHA, and **any finding that should feed back into the specs**.
- Commit and push the `EST-PM` clone.
- If this story was the epic's last one, run `scripts/set-status.sh E01 done`
  (its actual epic ID) for the parent epic too.

That last point matters: STR-001's history records that the Blocks SDK joins
scope and block ID with a hyphen, not the slash the specs assumed. Discoveries
like that are the loop's most valuable output. Surface them; do not silently
absorb them. Editing `EST-Spec` yourself requires gate G7.

---

## What "done" means

- The exit predicate is verifiably true (`next-story.sh --count` is 0).
- The verifier returned 0 on the final story.
- `STATE.md` has a final status row and a "Last run" timestamp.
- No gate in `HUMAN-GATES.md` is still open.
