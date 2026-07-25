# Branching Strategy

## `main`

- Always deployable. CI (`.github/workflows/ci.yml`) runs `npm test` on every push to `main` and on every PR.
- No long-lived `develop`/`staging` branch — the one-stack-per-society production model plus per-developer sandbox stacks (`npm run sandbox`) already give isolation without one.
- Branch protection (required PR reviews, required status checks) is currently **unavailable**: GitHub returns 403 on both the branch-protection and rulesets APIs for this repo (private + Free plan). Enforcement is convention-only until that changes — re-check with `gh api repos/manasXP/est-aws/rulesets` before assuming otherwise.
- Never force-push or reset `main`.

## Story branches — `story/STR-NNN`

- One branch per story from `est-pm/Stories`, created as `git worktree add ../est-aws-STR-NNN -b story/STR-NNN` so it doesn't collide with other in-flight work.
- Driven automatically by the `story-tdd` loop (`.claude/skills/story-tdd/SKILL.md`), but the same naming applies if a story is picked up manually.
- PR title/body cites the story ID, its acceptance criteria, and the `TC-*` cases it satisfies.
- Squash-merge into `main`, then delete the branch (local + remote) immediately.
- The automated loop never merges its own PR — a human always does (see `HUMAN-GATES.md` gate G3).

## Other work — `fix/`, `chore/`, `spike/`

For anything not tracked as a story:

- `fix/<short-desc>` — bug fixes
- `chore/<short-desc>` — non-behavioral maintenance (deps, CI config, docs)
- `spike/<short-desc>` — throwaway investigation; delete the branch when done regardless of outcome, and delete any spike code too unless it's explicitly promoted into a real story

Same flow as story branches: PR → squash-merge → delete branch.

## Submodule edits (`est-spec`, `est-pm`, `est-tcc`, `est-deploy`)

Each submodule is its own repo with its own convention — this repo's PR flow doesn't apply inside them. Current practice: `est-spec` and `est-pm` edits (spec wording, story status/frontmatter, revision history) push directly to their own `main`, no PR, after the exact wording is reviewed with the user. What lands in `est-aws` is only the submodule pointer bump, which follows the normal flow above — usually folded into the story's own PR, occasionally a separate "Bump submodule" commit straight to `main`.

## Commits

- One commit per PR (GitHub squash-merge); the PR title becomes the commit message, so write it as you want it to read in `git log`.
- No `--no-verify`, no bypassing CI.
