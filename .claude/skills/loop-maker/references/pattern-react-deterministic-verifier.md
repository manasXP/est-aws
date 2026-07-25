# Pattern: ReAct + Deterministic Verifier

**Default pattern.** Use this unless the brief clearly calls for something else.

---

## When to use

- One workstream: a single sequence of observe → act → check, processed one
  item at a time (or one batch at a time with a single cursor).
- The success criterion is program-checkable: you can write a script that reads
  the output and exits 0 (pass) or 1 (fail) without invoking an AI model to
  decide.
- Examples: compile a file and check the exit code; run a test suite and
  check the pass count; poll an HTTP endpoint and check the status code;
  count records in a file and compare to a target; assert a JSON schema.

If the criterion requires subjective judgment — "is this copy persuasive?",
"does this code follow the project's style spirit?" — use the
evaluator-optimizer pattern instead.

---

## Structure

```
run start
  ↓
read STATE.md        ← where did we leave off?
  ↓
discover             ← what is the next item to act on?
  ↓
act                  ← perform the action
  ↓
call verifier        ← script/program with binary exit code
  ↓ 0 (pass)         ↓ 1 (fail)
update STATE.md      escalate to human gate
  ↓
repeat or exit if goal predicate satisfied
```

The verifier is invoked as a shell command with a binary outcome. The loop
driver reads the exit code, not the verifier's prose output. Prose output is
useful for debugging but must never be used as the decision signal — only the
exit code counts.

---

## The verifier is a separate file

This is the defining constraint of the pattern. The verifier:

- Is a standalone script (shell, Python, or any executable) stored separately
  from the loop skill.
- Takes as input the path or identifier of the generator's output.
- Returns exit code 0 if the output meets the criterion, exit code 1 if not.
- Contains no calls to an AI model. It uses deterministic logic only.

Use the template at `scripts/verifier_template.sh` as the starting point.

A verifier embedded inside the skill, or delegated back to the same model that
generated the output, violates the pattern. The whole point is to separate
the producer from the judge.

---

## State

Use `loops/<name>/STATE.md` for the state file. A single-worker ReAct loop
processes items serially, so there is no concurrency concern and plain markdown
is the simplest choice. The state file records at minimum:

- `last_processed`: the identifier or cursor of the last item the generator
  handled successfully.
- `iteration_count`: how many iterations have completed.
- `status`: `running` | `paused` | `done` | `error`.

Update the state file *after* the verifier passes, not before. A state file
that records a step as complete before verification means a crash between act
and verify leaves the loop believing it succeeded.

---

## Exit predicate vs. budget

The loop stops when either:

1. **Goal predicate**: the condition defined in Q1 evaluates to true (e.g.,
   all items in the queue are processed, the target count is reached, the
   endpoint returns the expected state).
2. **Budget stop**: the hard limit recorded in `HUMAN-GATES.md` is hit —
   maximum iterations, maximum cost, or maximum elapsed time.

Both must be checked on every iteration. The budget is not optional even when
the goal predicate looks imminent.

---

## Human gates

At minimum:

- **Pre-run gate**: a human approves the first live execution after reviewing
  the blueprint.
- **Anomaly gate**: the verifier returns exit code 1 more than N consecutive
  times (set N in `HUMAN-GATES.md`). The loop pauses and waits for a human
  before retrying.

Add domain-specific gates for any action that is irreversible (sending a
message, deleting a record, pushing to production). These gates never go away,
even after the loop has run successfully many times.

---

## Anti-patterns

- **Self-assessment**: the generator evaluates its own output. Reject this.
- **Prose verdict**: the verifier outputs "looks good" and the loop parses
  the string. Reject this. Exit codes only.
- **Stateful skill**: progress counters or cursors stored in the skill file.
  They reset on every cold start.
- **Missing budget**: the loop will eventually run forever or until billing
  intervenes.
