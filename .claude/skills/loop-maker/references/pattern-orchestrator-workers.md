# Pattern: Orchestrator-Workers

Use when the loop's work naturally decomposes into genuinely parallel subtasks
that can be processed independently and then synthesized.

---

## When to use

- The work set for a single run contains multiple items with no dependency on
  each other: reviewing N pull requests, processing N files, generating N
  drafts for N topics.
- The items are independent: worker A's output does not affect what worker B
  should do.
- The speedup from parallelism justifies the added coordination overhead.
  For small item counts (fewer than ~5), serial ReAct is simpler and cheaper.

Do not use this pattern when items must be processed in order, when each item
depends on the previous result, or when the state backend cannot support
concurrent writes (a single plain STATE.md cannot — see isolation rule below).

---

## Structure

```
run start
  ↓
orchestrator reads STATE.md (or issue tracker) → work queue
  ↓
for each unclaimed item:
  dispatch worker sub-agent with isolated workspace
  ↓
workers run in parallel, each in its own worktree or scratch directory
  ↓
each worker completes its item, writes result to shared remote state
  ↓
orchestrator collects all results, synthesizes (aggregates, merges, summarizes)
  ↓
orchestrator runs verifier on synthesized output
  ↓
update shared state → repeat or exit
```

---

## Isolation: worktrees are required for file-modifying workers

When workers modify files, each must operate in an **isolated workspace**: a
separate git worktree, a temporary directory, or a container. Shared-workspace
parallel writers will conflict. The isolation rule is:

> One worker, one workspace. Workers never write to each other's directories.

After a worker's verifier passes, the orchestrator merges the worker's output
back to the main branch (or aggregates the result) before discarding the
workspace. Failed workspaces are preserved for inspection, not silently deleted.

---

## Shared remote state

Because workers run in isolation, they cannot share a local file for
coordination. Use a backend that supports concurrent reads and writes:

- **GitHub Issues / GitHub Projects** (preferred when available): one issue
  per work item. Claiming = assigning the issue to the worker. Done =
  closing the issue. The orchestrator polls open issues to find remaining work.
  Workers write their results as issue comments or linked artifacts.
- **Append-only log** (`loops/<name>/iterations.jsonl`) when GitHub is not
  available: each worker appends one JSON line when done. Append operations
  are atomic at the OS level, so concurrent writers do not corrupt the file.
  The orchestrator reads the log to track which items are complete.

The orchestrator is the only agent that writes to the synthesized output.
Workers write only their individual results (to the shared backend and to
their local isolated workspace).

---

## Synthesis

Synthesis is the orchestrator's core job and the step most likely to be
underspecified. Make it concrete before running the loop:

- What form does the synthesized output take? (A merged branch, a summary
  document, an aggregated report, a combined score.)
- How does the orchestrator resolve conflicts when workers produce
  contradictory results?
- What happens when some workers fail and others succeed? (Accept partial
  results? Retry failed workers? Surface to a human gate?)

Write the synthesis logic into the loop's skill file. An orchestrator that
only collects worker outputs but has no synthesis rule is not a loop — it is
a parallel launcher with no completion semantics.

---

## Verification

Two-level verification:

1. **Per-worker verifier**: each worker runs the shared verifier on its own
   output before reporting success to the orchestrator. A worker that cannot
   pass its verifier escalates to the human gate rather than reporting a
   spurious success.
2. **Synthesis verifier**: after the orchestrator synthesizes, a second
   verifier checks the combined output. This catches integration errors that
   no individual worker's verifier could detect.

Both verifiers are separate programs with binary exit codes — same constraint
as in the ReAct pattern.

---

## State

Use the shared remote backend (GitHub or append-only log — see above). The
orchestrator's `STATE.md` tracks high-level loop state: which batch is
running, total items, completed count, synthesis status. Individual worker
results live in the shared backend, not in the orchestrator's `STATE.md`.

---

## Human gates

- **Pre-run gate**: a human approves the work queue before the first dispatch.
  Parallel workers acting on the wrong items in parallel can amplify mistakes
  quickly.
- **Worker escalation gate**: a worker that fails verification pauses and
  flags the item. The orchestrator notes the failure in the shared backend and
  continues other workers, but does not proceed to synthesis until the flagged
  item is resolved.
- **Synthesis gate** (recommended for high-stakes output): a human reviews the
  synthesized output before it is published or pushed to production.
- **Irreversibility gates**: permanent, on every action that cannot be undone.

---

## Anti-patterns

- **Shared mutable local filesystem**: two workers writing to the same
  directory without isolation. File conflicts corrupt work silently.
- **No synthesis rule**: the orchestrator collects results but does not
  combine them into a coherent output. The loop "completes" without
  producing anything useful.
- **Orchestrator as worker**: the orchestrator takes on work items in addition
  to coordination. This conflates two jobs and makes failure modes harder to
  reason about. Keep orchestration and execution separate.
- **No per-worker verifier**: the orchestrator only checks the synthesis.
  Errors in individual worker outputs can be masked by the synthesis step and
  hard to trace afterward.
