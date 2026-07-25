# Host Adapters

Per-host translation table for the abstract actions used throughout `loop-maker`.
The skill body describes actions in neutral language ("dispatch a sub-agent",
"read a file", etc.). This file maps each action to the concrete mechanic on
each supported host.

**Hosts covered:** Claude Code · Codex · Hermes · OpenClaw

> **Stability note.** Scheduler APIs, sub-agent dispatch surfaces, and
> connector tool names are fast-moving. Before wiring any of these into a
> scaffolded loop, **verify against the current host's documentation**. The
> table reflects the host mechanics as understood at authoring time and may
> not reflect recent changes.

---

## Action map

| Abstract action | Claude Code | Codex | Hermes | OpenClaw |
|---|---|---|---|---|
| **Dispatch a sub-agent** | Spawn a subordinate via the `Agent` tool (available when running inside a harness that exposes it); or write an isolated `SKILL.md` and invoke it via `claude` CLI in a subprocess. **Verify against current host docs.** | Use the Codex API's `agents.run` endpoint or delegate via a tool-call chain within the same conversation thread. Check Codex agent-chaining docs for the current invocation pattern. **Verify against current host docs.** | Invoke Hermes's resident agent endpoint or call a named Hermes workflow step. Hermes may expose a direct agent-dispatch primitive or require routing through its task queue — check the Hermes task runner docs. **Verify against current host docs.** | Use OpenClaw's `dispatch` primitive or the `claw run <agent>` CLI command, depending on whether you are inside a running claw session or triggering externally. **Verify against current host docs.** |
| **Read a file** | Use the `Read` tool (preferred for known paths) or `Bash` with `cat`/`head` for programmatic pipelines. Both are available in a standard Claude Code session. | Read via the Codex file-context API or include the file in the `files` array of the run request. For local files, use a shell tool call (`bash`) if enabled. | Use Hermes's `read_file` tool or a shell command if the Hermes agent has shell access. Hermes's file tool respects the working-directory context set at session start. | Use `claw read <path>` or OpenClaw's built-in `ReadFile` tool. Fallback: a shell tool call (`bash -c "cat <path>"`) when the native read tool is unavailable. |
| **Run a shell command** | Use the `Bash` tool. Commands run in the agent's working directory; state does not persist across separate Bash calls. For stateful sequences, chain commands with `&&` or write a shell script and execute it. | Use the `bash` tool if the Codex run configuration enables it, or define a Code Interpreter code block. If shell access is not enabled, restructure the action as a Python or JS code block. | Hermes exposes a `run_shell` action or a sandboxed terminal. Check whether Hermes's shell runs in a container (common) — path assumptions may differ. **Verify against current host docs.** | Use `claw shell <command>` or the OpenClaw `ShellExec` tool. Commands run in OpenClaw's execution environment; confirm the working directory and PATH before wiring in scripts. |
| **Search the web** | No native web-search tool in the base Claude Code CLI. Options: (a) an MCP server that provides a search tool (e.g., Firecrawl, Brave Search, Exa) loaded into the session; (b) a Bash call to a search CLI (`ddgr`, `googler`, `curl` + an API). Install an MCP search server for reliable access. | Codex does not include native web search. Use the `web_search` tool if your Codex run configuration bundles it, or use a Retrieval tool pointed at a pre-indexed corpus. Fallback: shell `curl` against a search API. **Verify against current host docs.** | Hermes may provide a bundled search tool depending on the deployment configuration. If not present, route through an MCP-compatible search endpoint or a shell `curl` call to a search API. | OpenClaw includes a `WebSearch` tool in its default tool palette. Invoke it as `claw search "<query>"` or via the `WebSearch` tool call in an agent context. **Verify against current host docs.** |
| **Schedule / recurring run** | Use `CronCreate` (available when the schedule MCP is loaded) to register a cron-based trigger. Alternatively, write a crontab entry (`crontab -e`) that calls `claude --skill <path>` on a schedule. The Claude Code `schedule` skill wraps both. **Verify against current host docs.** | Codex does not have a native scheduler. Fallback options: (a) a GitHub Actions workflow with a `schedule` trigger that calls the Codex API; (b) an external cron job (`systemd` timer, macOS `launchd`, cloud scheduler) that POSTs to the Codex API endpoint. | Hermes supports scheduled workflow triggers via its built-in scheduler. Configure the trigger in the Hermes workflow definition (YAML or UI). For cron-style recurrence, use Hermes's `cron` trigger type. **Verify against current host docs.** | OpenClaw supports recurring runs via the `claw schedule <cron-expr> <agent>` command or the OpenClaw task-scheduler UI. For external scheduling, use a cron job that invokes `claw run`. **Verify against current host docs.** |
| **Run-until-condition** | Write a shell loop (`while ! <check>; do claude --skill <path>; done`) driven by a cron or a persistent process. Or use the `loop` skill to manage the retry cycle. The loop must include a budget check to avoid infinite execution. | Implement as a polling wrapper: a GitHub Action (or other external runner) that repeatedly calls the Codex API and checks the exit state against the predicate. Codex itself does not manage retry loops natively. | Hermes supports a `run-until` trigger or a looping workflow step in some deployment configurations. If unavailable natively, use an external orchestrator that polls a Hermes endpoint. **Verify against current host docs.** | OpenClaw has a `--until <predicate>` flag on `claw run` that re-invokes the agent until the predicate script exits 0, up to a configured retry ceiling. **Verify against current host docs.** |

---

## Notes on portability

- **Never hard-bind scaffolded SKILL.md or TRIGGER.md files to a single host's
  tool names.** Use the abstract action verbs in skill prose; resolve them to
  host specifics only in trigger and wiring code, with an explicit reference to
  this file.
- **Where a host lacks a native mechanic**, the fallback column shows a viable
  workaround. Document which fallback was chosen in `TRIGGER.md` so future
  operators know why the non-native path was selected.
- **Fast-moving surfaces** (sub-agent APIs, scheduler commands, search tools)
  are flagged inline. Check the host changelog before a production deployment
  of any loop that relies on them.

---

## Quick-reference: which host has what natively

| Capability | Claude Code | Codex | Hermes | OpenClaw |
|---|---|---|---|---|
| Native sub-agent dispatch | Yes (via harness) | Partial (tool-call chain) | Yes (workflow step) | Yes (`dispatch`) |
| Native scheduler | Via MCP / external cron | External only | Yes (built-in) | Yes (`claw schedule`) |
| Native web search | Via MCP server | Via tool config | Config-dependent | Yes (default palette) |
| Native shell access | Yes (`Bash` tool) | Config-dependent | Yes (sandboxed) | Yes (`ShellExec`) |
| Run-until-condition | Via loop wrapper | Via external poller | Config-dependent | Yes (`--until` flag) |
