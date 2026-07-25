# Pattern: Ralph (While-Loop Baseline)

**Teaching device.** Ralph is the crudest possible loop: a plain `while` that
keeps calling the agent until a fixed spec is satisfied. It has no separate
evaluator, no external state, and no connectors beyond what the agent's
context already holds. It is not recommended for production. It exists to show
the floor — the minimum structure a loop requires — so you can see exactly
what gets added when you move to a proper pattern.

---

## What Ralph is

Ralph is named after the mental model of a very determined but unsophisticated
person who re-reads the same instructions every morning and tries again from
scratch. He does not remember yesterday. He does not learn. He just tries until
it works or until someone tells him to stop.

In code terms, Ralph looks like this:

```
while not spec_is_satisfied():
    agent.run(spec)
```

That is the entire pattern. The spec is a fixed document. The agent reads it,
tries to satisfy it, and exits. An external driver checks whether the spec is
satisfied. If not, it calls the agent again.

---

## What Ralph gets right

- **It is simple.** There is no orchestration, no state file, no worktrees.
  You can prototype a loop in minutes.
- **It separates the spec from the agent.** The spec is external and fixed.
  The agent is not trusted to judge whether it succeeded — an external check
  does that.
- **It terminates (if the spec is satisfiable).** If the agent can eventually
  produce output that satisfies the spec, Ralph will get there.

These properties are enough to verify that a goal predicate is correctly
formulated before building a more capable loop around it.

---

## What Ralph gets wrong

### No memory between runs
Every invocation starts from scratch. Ralph re-reads the spec and starts over.
If the task involves many items or requires progress tracking, Ralph will re-
process everything on every run. For anything beyond a single-item task, this
is prohibitively expensive.

### No structured state
Without a state file, Ralph cannot track which items are done, cannot resume
after a crash, and cannot report progress. He just tries again from the top.

### No connectors
Ralph has no defined read or write connectors. He can only act within whatever
context is handed to him. If the task requires reading from a database or
writing to an API, those integrations must be built into the agent's prompt
or skill directly, which makes them harder to test and replace.

### The verifier is implicit
Ralph's "check" is often just `if output_looks_right`. In production loops,
that check must be a deterministic program with a binary exit code. Ralph
makes it easy to skip that step and use the agent's self-assessment instead
— which, as the backbone explains, is the first failure mode.

### No budget by default
Ralph's while-loop runs until the spec is satisfied or the process is killed.
It has no iteration cap, no cost ceiling, and no wall-clock limit. Every Ralph
implementation needs a budget wrapped around it before it is safe to run
unattended, even for a simple prototype.

---

## When Ralph is appropriate

- Exploring whether a goal predicate is well-formed, before building a real
  loop.
- One-shot tasks where there is a single item, no state to persist, and the
  action is idempotent (safe to repeat if it fails).
- Rapid prototyping where the spec may change every few minutes and you do not
  want to maintain a full scaffold.
- Teaching contexts where you are explaining loop mechanics and want the
  simplest possible example.

Do not deploy Ralph for any task that involves external writes, accumulates
state across iterations, or could run for more than a handful of iterations
without human review.

---

## Upgrading from Ralph

Ralph is a starting point, not a destination. When a Ralph prototype reveals
the shape of the loop, migrate to the ReAct + deterministic verifier pattern:

1. Extract the spec into a `SKILL.md`.
2. Move the exit check into a separate verifier script with a binary exit code.
3. Add a `STATE.md` so the loop can resume after a crash.
4. Add a budget (iteration cap, cost ceiling, or time limit) to `HUMAN-GATES.md`.
5. Add human gates before the first live run and on anomaly.

The upgrade takes the reliable parts of Ralph (a fixed spec, an external check)
and adds the missing parts (memory, separate verifier, budget). Nothing about
the spec or the goal needs to change — only the scaffolding around it.
