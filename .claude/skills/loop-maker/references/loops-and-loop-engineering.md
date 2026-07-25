# Loops and Loop Engineering

A knowledge backbone for `loop-maker`. Consult this file when reasoning about
how agent loops work, why they fail, and how to build ones that reliably reach
their goal and stop.

---

## The cold-start fact

Every time an agent loop fires, the agent wakes up with no memory of what it
did before. There is no persistent runtime — each invocation is a fresh
process that reads its environment from disk and starts reasoning from scratch.
This is the cold-start condition, and it is the central constraint of loop
design.

The implication is simple: anything the loop needs to know across runs must
live somewhere other than in the agent's in-context memory. Conventions go in
skill files. State — counters, cursors, which items are done, what happened
last time — goes in an external file the agent reads at the start of each run
and writes before it exits. Without both, the loop cannot make progress; it
just restarts from zero every time.

---

## The minimal loop

A correct loop has three and only three components:

1. **Generator** — the agent that observes the world and takes one step toward
   the goal. It reads the state file to know where it left off, performs one
   action, and writes an updated state file.

2. **Evaluator** (separate from the generator) — a program, script, or checker
   that examines the generator's output and returns a binary verdict: pass or
   fail. "Binary" is literal: an exit code of 0 (success) or 1 (failure), not
   a prose opinion. The evaluator must be a *separate file* from the loop
   skill. A generator that judges its own output is not a loop; it is an
   optimist.

3. **The repeat** — a driver that calls the generator, hands its output to the
   evaluator, and decides what to do next: proceed, retry, escalate to a human,
   or stop because the exit predicate is satisfied.

Remove any one of the three and the loop either runs forever, never verifies
its work, or has no continuity between invocations.

---

## The 6 building blocks

Good loop engineering (Addy Osmani uses the term "loop engineering" for this
discipline) means assembling six concerns and knowing what breaks when any one
is missing.

### 1. Scheduling
How the loop is triggered: a cron expression, a filesystem event, a webhook,
an API poll, or a manual dispatch. Without a defined trigger, the loop only
runs when someone remembers to start it — which is not a loop, it is a
one-shot.

### 2. Isolation / worktrees
When a loop does work that modifies files, it should operate in an isolated
workspace (a worktree, a scratch directory, a container) so that partial or
failed work cannot corrupt the main branch. Isolation also enables parallel
execution: multiple workers can act on separate items at the same time without
stepping on each other's changes. Without isolation, a bad iteration leaves
the working tree in an undefined state, and parallel runs produce conflicts.

### 3. Skill
The durable, read-only logic the agent loads each run: the goal definition,
the action procedure, the discovery query, and the call to the verifier. It
does not change between runs. It carries *logic*, never *state*. Without a
stable skill file, each invocation may behave differently because the
instructions drifted.

### 4. Connectors
The interfaces the loop uses to read from and write to the world: a GitHub
API client, a filesystem reader, a database cursor, a message queue consumer.
Without a defined connector, the loop's discovery or action step is
underspecified — it knows *what* to do but not *how* to talk to the system
that holds the data.

### 5. Sub-agents
For work that can be decomposed, the orchestrating loop dispatches sub-agents
to handle individual items in parallel. Each sub-agent is isolated (its own
worktree or scratch space) and reports back a structured result. Without
sub-agents, a loop that processes many items must serialize them all, which
is slow and means one failure blocks everything downstream.

### 6. Memory / state
The external file (or issue tracker, or append-only log) that holds everything
that changes between runs: cursors, counters, item status, iteration history,
accumulated partial results. Without an external state file, the loop re-
discovers what it already did on every cold start, cannot track progress
across interruptions, and has no way to detect when it is done.

---

## The durable-vs-changing rule

Split every piece of information by one question: *does this change between
runs?*

- **No** → it is durable. It belongs in a skill file, loaded read-only at
  the start of each run. Examples: the goal definition, a style guide, a
  rubric, a schema, a list of known-good examples.

- **Yes** → it is changing state. It belongs in an external state file (or
  issue tracker), read at the start of each run and written before the run
  exits. Examples: which items are processed, the current cursor or timestamp,
  the iteration count, intermediate results.

Mutable state stored in a skill file is the most common loop anti-pattern. It
appears to work the first time, then silently disappears on the next cold
start when the skill is reloaded from disk in its original form.

---

## Q6 state-backend menu and isolation rule

The answer to Q6 (what does the loop need to remember?) determines both what
goes in the state file and *which* state backend to use. The choice depends on
the isolation model:

| Isolation model | State backend |
|---|---|
| Single worker — one run at a time | `loops/<name>/STATE.md` — plain markdown file; the agent reads it at run start, overwrites it at run end |
| Parallel / worktree — multiple workers per run | GitHub Project or GitHub Issues — one issue per work item; closing = done; supports concurrent reads and writes without file-lock conflicts |
| Parallel but no GitHub access | `loops/<name>/iterations.jsonl` — append-only; each worker appends one JSON line per completed iteration; no file-lock required because appends are atomic at the OS level |

An optional MCP-backed tracker (task manager, project board) may layer on top
of any of these to provide a richer view, but the backend above is always the
source of truth. If the user overrides this recommendation, document the
override and why in `TRIGGER.md`.

The **isolation rule** follows from the worktree entry: whenever two or more
iterations may run concurrently, each must have its own isolated workspace.
A shared working tree with concurrent writers is not a loop; it is a race
condition.

---

## Three failure modes

### 1. No separate verifier
The generator checks its own output. Self-assessment is systematically biased
toward "looks good" — a model that produced a flawed result is the least
reliable judge of that result. The evaluator must be a separate program with a
checkable criterion. If you cannot write the verifier as a script with an exit
code, the goal is not yet precise enough to automate.

### 2. Mutable state stored in the skill
The skill file is read from disk on every cold start. Any state written into it
during a run is overwritten the next time the loop fires. Counters silently
reset. Progress is lost. Checksums go stale. The fix is always the same: move
the mutable data out of the skill and into the state file.

### 3. No stop condition
A loop that has no checkable exit predicate runs indefinitely — either cycling
through already-completed work, burning tokens on items that will never
satisfy the goal, or silently accumulating cost until something external
(a billing limit, a human killing the process) stops it. Every loop must have
a predicate that the verifier can evaluate to determine "done", and a hard
budget (maximum iterations, cost ceiling, or wall-clock limit) that stops the
loop even if the predicate is never satisfied.

---

## Limitations

### Prompt injection and permanent human gates

Because the generator reads external data (issue bodies, file contents, API
responses), any malicious content in that data can attempt to redirect the
agent's behavior. A compromised loop running with write access is dangerous.
The mitigation is not purely technical: irreversible or high-stakes actions
(sending external messages, pushing to production, deleting data) must have a
permanent human gate regardless of how confident the agent is. No
self-assessed confidence score overrides this gate.

### Verification is the hard part

Writing the generator is usually straightforward. Writing a verifier that
catches all the ways an action can be subtly wrong is the hard problem. A
verifier that only checks "did the file appear?" misses malformed content. A
verifier that checks structure misses semantic errors. Plan verification time
accordingly. The quality of a loop is bounded by the quality of its verifier.

### Token economics: budgets are mandatory

Long-running loops can exhaust context windows, hit rate limits, or spend real
money. Anthropic's *Building Effective Agents* guidance emphasizes setting
explicit token and cost budgets for agentic workflows — not as a soft
suggestion but as a hard stop. Every loop designed with this skill must have
a budget recorded in `HUMAN-GATES.md` before it is considered scaffolded. A
loop without a budget is a liability, not an automation.

---

## Uncertainty flag for `/goal`, `/loop`, and `/schedule`

The commands `/goal`, `/loop`, and `/schedule` exist in some agent hosts but
not all, and their syntax and behavior vary across versions. Any reference to
these commands in a scaffolded output must carry an explicit flag:

> **Verify `/goal` / `/loop` / `/schedule` against current host docs before
> using — command availability and syntax are host-specific and may have
> changed since this skill was written.**

Do not assume the exact flag syntax, option names, or behavior from training
data. Check the live host documentation.
