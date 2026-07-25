# Pattern: Evaluator-Optimizer

Use when the success criterion requires judgment that a deterministic script
cannot express. The evaluator scores the generator's output against a rubric;
the optimizer rewrites or adjusts until the score meets the threshold.

---

## When to use

- The output quality depends on criteria that a program cannot test with a
  binary exit code: tone, clarity, persuasiveness, adherence to a style
  guide, coherence with surrounding context.
- You can write a rubric — a set of named dimensions with explicit scoring
  instructions — even if you cannot encode it as a regex or a schema check.
- Examples: reviewing generated copy against a brand voice guide; checking
  whether a summary captures the key points of a source document; evaluating
  whether a proposed code change matches the architecture conventions of the
  project.

If the criterion is fully program-checkable (schema, exit code, count), use the
ReAct + deterministic verifier pattern instead. It is simpler and faster.

---

## Structure

```
run start
  ↓
generator produces output (draft, code, summary, etc.)
  ↓
evaluator reads output + rubric → score per dimension
  ↓
score meets threshold?
  ↓ yes                ↓ no (within retry budget)
accept output          optimizer receives output + evaluator feedback
  ↓                    ↓
update STATE.md        generator revises output
  ↓                    ↓
repeat or exit         re-evaluate
                       ↓
                    retry budget exhausted → human gate
```

The evaluator and the optimizer (generator) are **separate agents or calls**.
The evaluator must not be the same invocation that produced the output.

---

## The evaluator

The evaluator's job is to apply the rubric and return a structured score —
not a free-form opinion. The score should be machine-readable (a JSON object
with per-dimension numeric scores and required improvement notes) so the
optimizer loop can stop when the threshold is met without parsing prose.

**Prefer a different model for the evaluator.** When the evaluator uses the
same model as the generator, the two share the same systematic biases — the
generator and evaluator tend to agree on the same subtle errors. Using a
different model (or, at minimum, a different prompt context with no memory of
the generation step) reduces this correlation and catches more issues.

---

## The rubric

Write the rubric before the loop starts. It must specify:

- **Dimensions**: the named qualities to assess (e.g., "accuracy", "tone",
  "completeness", "conciseness").
- **Scoring scale**: numeric (e.g., 1–5) or categorical (pass / needs-work /
  fail) per dimension.
- **Threshold**: the minimum score (per dimension and overall) that the loop
  accepts without revision.
- **Improvement instructions**: for each scoring level below threshold, what
  the optimizer must fix. Vague rubrics ("make it better") produce circular
  revisions that never converge.

The rubric is durable knowledge. It belongs in the loop's skill file (or a
companion knowledge skill), not in the state file.

---

## State

Use `loops/<name>/STATE.md` for single-worker runs. The state file should
record:

- The current draft (or a path to it).
- The evaluator's most recent score per dimension.
- The revision count for the current item.
- A cursor or item identifier so the loop knows which item it is working on.

Write the state file after each evaluator pass — before retrying — so that a
crash mid-revision can be resumed without starting the item from scratch.

---

## Retry budget and stop condition

Set a maximum revision count per item (e.g., three rounds of optimize →
re-evaluate). If the output still does not meet the threshold after N rounds,
the loop escalates to a human gate rather than cycling forever.

The overall loop also needs a total budget (maximum items processed, maximum
token spend, or wall-clock limit) recorded in `HUMAN-GATES.md`.

---

## Human gates

- **Pre-run gate**: a human reviews the rubric and threshold before the first
  live run. An unchecked rubric means the loop may optimize toward the wrong
  criteria silently.
- **Per-item escalation**: when revision budget is exhausted without reaching
  threshold, the item is flagged for human review. The loop pauses on that
  item (or skips it and logs it) — it does not silently accept below-threshold
  output.
- **Irreversibility gate**: if the accepted output is published, sent, or
  otherwise pushed to an external system, add a gate before that action.

---

## Anti-patterns

- **Evaluator is the generator**: the same model call that produced the output
  also grades it. This guarantees systematic agreement on errors.
- **Prose-only score**: the evaluator outputs "this needs improvement" without
  structured per-dimension scores. The optimizer has no reliable signal to act
  on, and the loop cannot detect convergence.
- **No retry cap**: the loop keeps revising indefinitely. Every evaluator-
  optimizer loop needs a per-item revision ceiling.
- **Vague rubric**: dimensions like "quality" or "good" without scoring
  criteria produce circular evaluations. Define what each score level looks
  like before running the loop.
