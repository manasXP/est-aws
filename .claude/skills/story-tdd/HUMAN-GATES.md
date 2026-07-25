# story-tdd — Human Gates & Budget

> A loop without human gates can act in ways no one intended.
> A loop without a budget can run forever. Both sections are required.

---

## Human gates

| # | Gate | Trigger condition | Who approves |
|---|------|-------------------|--------------|
| G1 | Pre-run sign-off | Before the very first live run | Loop owner |
| G2 | Verifier anomaly | Verifier exits 1 on any story | Loop owner |
| G3 | **Merge** | Every PR, unconditionally. The loop pushes a branch and opens a PR; it never merges | Loop owner (reviewer) |
| G5 | Spend / bill | Before any story whose work provisions AWS resources (`npm run sandbox`, `npm run deploy` — e.g. STR-004, STR-014). Local-first Blocks runtime needs no account; real deploys do | Budget owner |
| G6 | Delete / overwrite | Before deleting a worktree with uncommitted work, force-pushing, or rewriting story frontmatter that a human edited since the loop last read it | Loop owner |
| G7 | **Spec edit** | Before modifying anything in `EST-Spec/` (a separate clone and the source of truth for scope). The loop records spec findings in the story's Revision History and the PR body; a human makes the spec change | Loop owner |
| G8 | **Migration discipline** | Before any story adding a destructive SQL migration. Expand-contract is mandatory (STR-012); a contract step that drops a column or table stops here | Loop owner |

G4 (send/publish) is intentionally omitted — the loop sends nothing external.
Opening a PR on a private repo is covered by G3.

### How to clear a gate

1. The loop writes a gate-request row to `loops/story-tdd/STATE.md` with the
   gate ID, the story, the reason, and the proposed action.
2. A human reviews and replies with an explicit approval — for G3 that is
   merging the PR; for the others, a clear go-ahead.
3. The loop records the clearance in `STATE.md`, then continues.

**Never self-approve.** In particular the loop must never edit `verifier` to
make a failing story pass — that is the one change that would invalidate every
verdict the loop has ever produced. Verifier changes are a human edit, reviewed
on their own PR, never bundled with a story.

---

## Budget / stop

Hard stops. On breach the loop halts, writes `budget-exceeded` to `STATE.md`,
and waits.

| Dimension | Limit | Action on breach |
|-----------|-------|-----------------|
| Stories per run | **1** | Stop after the PR is opened |
| Consecutive verifier failures (same story) | **3** | Mark story `blocked`, halt, open G2 |
| Agent iterations per story | **25** | Halt + write budget-exceeded |
| Wall-clock per story | **90 minutes** | Halt + write budget-exceeded |
| Consecutive dependency skips (same story) | **3** | Mark story `blocked`, halt |

### Why a hard stop is required

The loop cold-starts each run with no memory of how often it has already fired.
The counters in `STATE.md` are the only reliable brake, because they persist
across cold starts — an in-session counter resets and cannot bound anything.

---

## Note on the parallel-worktree caveat

The generic loop-maker guidance describes per-worktree state files for
concurrent workers. **That does not apply here.** This loop is strictly serial —
one story per run, one worktree at a time, a single `STATE.md`. The stories are
dependency-ordered against one repo (`est-aws`), so parallelism would fight the
ordering rather than help.

If that ever changes, markdown is the wrong backend: it has no concurrency
safety. Move state to GitHub Issues (one per story, closed = done) or add a
claim/lease field to the story frontmatter first.
