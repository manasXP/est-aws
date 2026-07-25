---
name: loop-maker
description: >
  Designs and scaffolds a self-running, self-verifying agent loop from a
  7-question blueprint. Trigger on: automate a recurring task, schedule an
  agent, run unattended, monitor a condition, triage a queue, poll on a
  cadence, or turn any manual workflow self-running — even if you never
  say the word "loop". Walks through elicit → survey → select → scaffold,
  producing 6 building blocks with a human-gate list and a budget/stop rule.
---

# loop-maker

A 4-phase wizard that turns any "I want this to run by itself" intent into a
deployable, auditable agent loop. The output is concrete: a skill folder, a
separate verifier program, a state file, human gates, a trigger definition,
and a budget. Nothing runs until you approve the blueprint.

---

## The one rule

> **Durable knowledge → a skill (read-only each run).
> Changing state → an external state file (read+written each run).**

A skill is loaded fresh each time the loop fires. It must never accumulate
knowledge between runs — it only carries the logic. Everything that evolves
(progress counters, last-seen timestamps, iteration results, queue position)
lives in a file the loop reads and writes. Mutable state in a `SKILL.md` is
the anti-pattern: it silently disappears the moment the next run loads the
skill from disk.

---

## Why loops need this

An agent cold-starts every run. It has no memory of the previous execution
unless something on disk told it what happened. Without conventions, each run
starts from scratch, rediscovers context, and has no way to know when it is
done. The wizard enforces two things: a checkable exit predicate (so the loop
knows when to stop) and an external state file (so it knows where it left off).
Together they give the loop a consistent world-view across cold starts.

---

## Process: 4 phases

```
elicit  →  survey  →  select  →  scaffold
```

Work through these phases in order. At the start of each phase, print the
breadcrumb:

```
python scripts/loop_progress.py breadcrumb <phase>
```

Create one todo item per phase and check it off before moving to the next.
Do not scaffold until the blueprint is approved.

---

## Phase 1 — Elicit (7 questions, one at a time)

### Detect-first rule

Before asking anything, silently probe the environment:

- Is the working directory a git repo? Is there a remote? (`git remote -v`)
- Is `gh` installed and authenticated? (`gh auth status`)
- Are there existing skills in the host's skill directory that match the goal?
- Is there an active `loops/` folder with a matching name?
- Is there a cron entry, scheduler config, or trigger file already in place?

For any question whose answer the environment reveals, print
`(detected: <value>)` and skip asking the user — this lowers `<total>` in the
progress bar. Show the user what was detected so they can correct it if wrong.

### Asking the questions

Print a progress bar before each question you actually ask:

```
python scripts/loop_progress.py bar <n> <total>
```

`<n>` is the question number (counting only un-detected ones), `<total>` is
how many remain un-detected at elicit start. Ask one question, wait for the
answer, then move to the next.

### The 7 questions

**Q1 — Goal** (maps to the loop's exit predicate)
> What condition means the loop is done? State it as something you could
> check with a program — a file exists, an HTTP endpoint returns 200, a count
> reaches a target, a queue is empty. A vibe ("it looks good") won't work;
> a checkable predicate will.

**Q2 — Trigger** (maps to TRIGGER.md)
> How does the loop start each run? Options: a cron schedule, a filesystem
> event, an inbound webhook, an API poll, a manual `gh workflow dispatch`, or
> "run until the goal predicate holds, then stop". Pin down the schedule or
> event precisely — a vague "every day" becomes "0 9 * * 1-5" or similar.
> Flag: verify the exact trigger syntax against current host docs.

**Q3 — Discovery**
> What does the loop look at each run to decide what to do? Examples: a
> directory listing, a GitHub issue list, an RSS feed, a database query, an
> API response. This determines the read connector.

**Q4 — Action** (maps to the loop's core skill step)
> What does the loop actually do each iteration — to what target, using which
> connector? Note: if the action creates or modifies files, consider running
> it in a worktree or scratch directory so each iteration is isolated and the
> main branch is only updated after verification passes.

**Q5 — Verification** (maps to the verifier — a SEPARATE checker)
> How does the loop prove each iteration succeeded before moving on? This must
> be a program with a binary verdict, not a model's opinion. The verifier runs
> after every action and gates the next iteration. It is a separate file from
> the loop skill — template at `scripts/verifier_template.sh`.

**Q6 — State**
> What does the loop need to remember between runs? Examples: which items have
> been processed, the last cursor or timestamp, the current iteration count,
> accumulated results. This goes in the state file — see the state backend
> rule below.

**Q7 — Human gates**
> At which points must a human approve before the loop continues? At minimum:
> before the first real run, and when the verifier signals an anomaly. Add
> any domain-specific gates (e.g., before touching production data, before
> sending external messages, when cost exceeds a threshold).

### Two additional captures

**Durable knowledge:** Is there anything the loop needs to know that does not
change between runs — a style guide, a rubric, a list of known-good examples,
a schema? This becomes the loop's own skill, installed alongside the main
skill and loaded read-only each run.

**Budget / stop rule:** What is the maximum cost, iteration count, or elapsed
time before the loop must halt even if the goal predicate has not been met?
This is non-negotiable. A loop without a budget can run forever. Record it as
a hard stop, not a soft suggestion.

---

## Phase 2 — Survey reuse (two passes)

### Pass 2a — Installed capabilities

Check which connectors, skills, and tools are already available in the host
environment. For each one relevant to the loop's action or discovery step,
record a named fallback. Example: if `gh` is present, the GitHub connector is
wired; if a Slack MCP server is loaded, the Slack connector is wired. List
what is available so the scaffold can wire them in rather than stub them.

### Pass 2b — Skill bank search

Dispatch a search sub-agent over `references/skill-bank/`. The sub-agent reads
each entry and returns any skill that overlaps with the loop's goal, trigger, or
action. Anything found gets noted as a reuse candidate — the scaffold will
import or extend it rather than duplicate it.

---

## Phase 3 — Select the simplest pattern

Choose the loop pattern from the table below. Default: **ReAct + deterministic
verifier** unless the brief clearly calls for something else. Load only the
reference file for the chosen pattern — don't read the others.

| Pattern | When to use | Reference file |
|---|---|---|
| **ReAct + deterministic verifier** (DEFAULT) | One workstream, "done" is a program-checkable predicate | `references/pattern-react-deterministic-verifier.md` |
| Evaluator–optimizer | Criteria need judgement, not just a script | `references/pattern-evaluator-optimizer.md` |
| Orchestrator–workers | Work genuinely parallelizes into independent subtasks | `references/pattern-orchestrator-workers.md` |
| Ralph | Want a crude baseline / teaching loop | `references/pattern-ralph.md` |

State the chosen pattern and one-line rationale before moving to Phase 4.
Flag: verify the host's scheduler and dispatch mechanics against
`references/host-adapters.md` — syntax varies across Claude Code, Codex,
Hermes, and OpenClaw.

---

## Phase 4 — Emit blueprint, then scaffold

### Step 4a — Blueprint approval contract

Before writing any files, render the filled blueprint:

```
python scripts/loop_progress.py blueprint \
  GOAL    "<the checkable predicate from Q1>" \
  TRIGGER "<schedule or event from Q2>" \
  VERIFY  "<verifier command from Q5>" \
  STATE   "<state file path and format>" \
  GATES   "<human gate list from Q7>"
```

Present the rendered box to the user. Do not write files until the user
approves. If anything is wrong, correct it in the elicit answers and re-render.

### Step 4b — Scaffold the 6 building blocks

Split by durability:

**Durable (installed into the host's skill directory):**

These files do not change at runtime. Install them to
`<host-skills-dir>/<loop-name>/` using the templates in `templates/`:

1. `SKILL.md` — the loop's core skill (goal, action, discovery, call to
   verifier). Read-only each run. Generated from `templates/loop-SKILL.md.tmpl`.
2. `verifier` — the deterministic checker, adapted from
   `scripts/verifier_template.sh`. Binary exit code: 0 = condition holds; for
   the goal predicate that means "stop the loop"; for a per-iteration check it
   means "this attempt passed". 1 = condition does not hold (iterate / retry).
3. `HUMAN-GATES.md` — the gate list from Q7, plus the budget/stop rule.
   Generated from `templates/HUMAN-GATES.md.tmpl`.
4. `TRIGGER.md` — the trigger definition from Q2 (cron expression, event
   spec, or run-until-done config). Generated from `templates/TRIGGER.md.tmpl`.

**Changing (written to the working tree, read+written each run):**

5. `loops/<loop-name>/STATE.md` (or the backend selected below) — the state
   file. Generated from `templates/STATE.md.tmpl`; initialize with the current
   timestamp and empty counters.
6. If durable knowledge was captured: a second installed skill at
   `<host-skills-dir>/<loop-name>-knowledge/SKILL.md` containing that
   read-only reference material.

After scaffolding, print the file tree so the user can confirm nothing is
missing.

---

## State backend rule

Choose the state backend by isolation model, then record the choice in
`loops/<loop-name>/STATE.md` or document it in `TRIGGER.md`:

| Isolation model | State backend |
|---|---|
| Single worker (one run at a time) | `loops/<name>/STATE.md` — plain markdown, read+written each run |
| Parallel / worktree | GitHub Project or GitHub Issues — one issue per work item; resolved = done |
| Parallel but no GitHub | `loops/<name>/iterations.jsonl` — append-only; one JSON line per iteration |

The user may override this recommendation. Document the choice and the reason
for any override.

---

## Human gates + budget: non-negotiable

A loop without human gates can act in ways no one intended. A loop without a
budget can run forever or exhaust resources silently. Both are required.

- **Gates** must appear in `HUMAN-GATES.md` before the loop is considered
  scaffolded. At minimum: one gate before the first live run, one gate if the
  verifier signals an anomaly.
- **Budget** must appear in `HUMAN-GATES.md` as a hard stop: maximum
  iterations, maximum cost in dollars, maximum elapsed wall time, or all three.

Do not declare the loop done if either is missing. If the user skipped Q7 or
the budget capture, surface it now and collect the answers before writing files.

---

## Cross-harness note

This skill is designed to run on Claude Code, Codex, Hermes, and OpenClaw.
The wizard describes actions in host-neutral language: "dispatch a sub-agent",
"read a file", "run a shell command", "write a file". These map to different
primitives on each host. Before wiring a trigger, scheduler, or sub-agent
dispatch into a scaffolded loop, consult:

```
references/host-adapters.md
```

That file lists the per-host equivalents for scheduling, sub-agent launch,
file I/O, and connector access. Never hard-bind scaffolded files to a single
host's tool names — use the adapter layer so the loop is portable.

---

## Output discipline checklist

Before handing off the scaffolded loop, verify all of the following. If any
item is missing, fix it before declaring done.

- [ ] All 7 questions answered (Goal · Trigger · Discovery · Action ·
      Verification · State · Human gates) and recorded in the blueprint
- [ ] Separate verifier file exists and has a binary exit code
- [ ] External state file exists at the correct path for the chosen backend
- [ ] `HUMAN-GATES.md` is present and includes at minimum one pre-run gate and
      one anomaly gate
- [ ] Budget / stop rule is written into `HUMAN-GATES.md` as a hard limit
- [ ] Any trigger or scheduler syntax is flagged "verify against current host
      docs" with a pointer to `references/host-adapters.md`
- [ ] Any `/goal`, `/loop`, or `/schedule` command referenced in output is
      flagged "verify against current host docs" — host command surfaces
      change; do not assume the flag or syntax from training data
