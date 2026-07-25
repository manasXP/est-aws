# story-tdd — Trigger Definition

## Verifiable goal

> No story in `EST-PM/Stories/M*/STR-*.md` has `status: todo` with all upstream
> epics `done`.

```bash
.claude/skills/story-tdd/scripts/next-story.sh --count   # 0 => drained
```

The queue grows: M2–M5 stories are cut just-in-time when their epic starts, so
reaching 0 means drained-for-now. Re-run after new stories land.

## State file

```
loops/story-tdd/STATE.md
```

Read at startup, written before stopping. Missing or empty => first run;
initialize the ledger before acting.

---

## Trigger: manual dispatch, run-until-queue-empty

**Not scheduled, deliberately.** The loop halts at gate G3 (merge) after every
story, so a cron trigger would only pile up unreviewed PRs — the cadence is set
by how fast you review, not by the clock. Start a run when you are ready to
review one.

### Launch prompt (host-agnostic fallback)

> Read `loops/story-tdd/STATE.md` and the `story-tdd` skill, then run one
> iteration of the story-tdd loop.

Works on any host that can read a file and load a skill.

### Claude Code

Invoke the skill directly:

```
/story-tdd
```

A newly scaffolded skill registers without a session restart — verified when
this loop was scaffolded. **Verify against current host docs** — the
`/goal` and `/loop` command surfaces referenced in the generic loop-maker
template change between versions; do not assume their flags. See
`.claude/skills/loop-maker/references/host-adapters.md`.

If you want several stories back-to-back in one sitting, re-invoke after each
merge rather than reaching for `/loop` — the merge gate is the pacing mechanism
and automating around it defeats the design.

### Other hosts

Consult `host-adapters.md` for Codex / Hermes / OpenClaw equivalents. Do not
hard-bind this loop to any host's tool names; the skill body uses neutral verbs
(read a file, run a shell command, open a PR) precisely so it stays portable.

---

## Trigger notes

- Before the first run, clear gate **G1** in `HUMAN-GATES.md`.
- The budget in `HUMAN-GATES.md` takes precedence over any trigger. One story
  per run is a hard stop, not a default.
- The loop needs `gh` authenticated (detected: `manasXP`) and a clean
  `~/code/est-aws` on `main` with no stray `story/STR-*` worktrees.
