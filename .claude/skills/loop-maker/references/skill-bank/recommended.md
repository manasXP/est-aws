# Skill Bank — Recommended Borrowable Capabilities

A curated catalog of publicly available capabilities that a scaffolded loop can
borrow or extend rather than rebuild from scratch. Organized by the loop block
each one serves. The search sub-agent (`search-agent.md`) reads this file to
propose a relevance-ranked shortlist for a specific loop's needs.

---

## How to read this catalog

| Column | Meaning |
|---|---|
| **Name** | The skill, tool, or library as it is publicly known |
| **Where to get it** | Install path, npm/pip/brew command, or repo URL |
| **Block** | Which of the 6 loop building blocks it covers (verifier / connector / worker / runtime / scheduler / state) |
| **Why** | One-line reason it is useful here |
| **Fallback** | What to use if this capability is unavailable or incompatible |

---

## Verifier block

Skills and tools that provide a binary pass/fail verdict on a generator's output.

| Name | Where to get it | Block | Why | Fallback |
|---|---|---|---|---|
| **pytest** | `pip install pytest` / [pytest.org](https://pytest.org) | verifier | Runs a deterministic test suite and exits 0/1 — a natural verifier harness for code-generating loops. | A hand-written shell script that runs the executable and checks its exit code. |
| **shellcheck** | `brew install shellcheck` / [shellcheck.net](https://www.shellcheck.net) | verifier | Statically checks shell scripts and exits non-zero on errors — useful when the loop generates shell artifacts. | Manual `bash -n` syntax check plus a custom lint rule script. |
| **jsonschema (Python)** | `pip install jsonschema` / [python-jsonschema.readthedocs.io](https://python-jsonschema.readthedocs.io) | verifier | Validates a JSON file against a schema and exits non-zero on mismatch — good for loops that emit structured data. | `jq` + a hand-written type-assertion script. |
| **markdownlint-cli** | `npm install -g markdownlint-cli` / [github.com/igorshubovych/markdownlint-cli](https://github.com/igorshubovych/markdownlint-cli) | verifier | Checks markdown files for structural errors; exit code 1 on violations. Useful when the loop generates or edits docs. | A regex-based custom lint script. |
| **httpie** | `pip install httpie` / [httpie.io](https://httpie.io) | verifier | Verifies that an HTTP endpoint returns the expected status code or body fragment; exits non-zero on failure. | `curl -f` (fails on HTTP errors) plus `grep` for body assertions. |

---

## Connector block

Tools that give the loop read/write access to external data sources.

| Name | Where to get it | Block | Why | Fallback |
|---|---|---|---|---|
| **gh CLI** | `brew install gh` / [cli.github.com](https://cli.github.com) | connector | Reads and writes GitHub Issues, PRs, and Projects — covers the issue-tracker state backend and common discovery sources. | Direct GitHub REST API via `curl` with a personal access token. |
| **Firecrawl MCP** | [github.com/mendableai/firecrawl-mcp-server](https://github.com/mendableai/firecrawl-mcp-server) | connector | Provides web-scrape and search tools to an MCP-aware host; no custom HTTP plumbing needed. | `curl` + `jq` against a search API, or the Brave Search API. |
| **rclone** | `brew install rclone` / [rclone.org](https://rclone.org) | connector | Syncs files between the local working tree and 70+ cloud storage providers (S3, GCS, Dropbox, etc.). | Vendor-specific CLI (`aws s3 cp`, `gsutil`). |
| **resend SDK** | `npm install resend` / [resend.com/docs](https://resend.com/docs) | connector | Sends transactional email with a simple API and JSON response; useful for loops that need to notify on completion or anomaly. | `sendmail` or `msmtp` for local SMTP; Mailgun or SendGrid REST API via `curl`. |
| **Supabase CLI** | `npm install -g supabase` / [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli) | connector | Reads and writes a Postgres-backed Supabase project; covers database-backed state and discovery sources. | `psql` with a direct connection string. |

---

## Worker block

Skills and utilities that perform the loop's core action step.

| Name | Where to get it | Block | Why | Fallback |
|---|---|---|---|---|
| **ffmpeg** | `brew install ffmpeg` / [ffmpeg.org](https://ffmpeg.org) | worker | Processes audio/video assets deterministically; exit code 1 on failure. Ideal worker for media-transformation loops. | A cloud transcoding API (e.g., Cloudinary, Mux) via `curl`. |
| **pandoc** | `brew install pandoc` / [pandoc.org](https://pandoc.org) | worker | Converts between document formats (markdown ↔ HTML ↔ PDF ↔ DOCX) with a predictable exit code. | A Python script using `markdown` + `weasyprint`. |
| **ImageMagick** | `brew install imagemagick` / [imagemagick.org](https://imagemagick.org) | worker | Resizes, crops, and annotates images non-interactively; exit code 1 on failure. | `sharp` CLI (`npm install -g sharp-cli`) for Node-native pipelines. |
| **prettier** | `npm install -g prettier` / [prettier.io](https://prettier.io) | worker | Formats code or JSON files in place; exit code 1 on check-mode failures. Useful as a post-generation cleanup step. | `black` (Python), `gofmt` (Go), or `rustfmt` (Rust) for language-specific formatting. |
| **Remotion CLI** | `npx remotion` / [remotion.dev](https://remotion.dev) | worker | Renders React-based video compositions to MP4 from a script; exit code 1 on render failure. | A headless Puppeteer/Playwright screen-recorder script. |

---

## Runtime / scheduler block

Capabilities that drive when and how the loop fires.

| Name | Where to get it | Block | Why | Fallback |
|---|---|---|---|---|
| **GitHub Actions (schedule trigger)** | [docs.github.com/en/actions](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule) | scheduler | Provides a managed cron runner that triggers a workflow on a `cron` expression; free for public repos. | A `launchd` plist (macOS) or `systemd` timer (Linux) that calls the loop CLI. |
| **Vercel Cron Jobs** | [vercel.com/docs/cron-jobs](https://vercel.com/docs/cron-jobs) | scheduler | Runs a Vercel Function on a cron schedule; no separate infrastructure needed if the project is already on Vercel. | A Cloudflare Worker with a `scheduled` event handler. |
| **node-cron** | `npm install node-cron` / [npmjs.com/package/node-cron](https://www.npmjs.com/package/node-cron) | scheduler | In-process cron scheduler for Node.js loops that should self-drive without an external trigger. | `setInterval` + a process manager (`pm2`) to survive restarts. |

---

## State block

Backends for tracking what the loop has done and where it left off.

| Name | Where to get it | Block | Why | Fallback |
|---|---|---|---|---|
| **GitHub Issues (via gh CLI)** | Built into `gh` / [cli.github.com](https://cli.github.com) | state | One issue per work item; closing = done; concurrent-safe for parallel loops. | An append-only `iterations.jsonl` file in the loop's working directory. |
| **lowdb** | `npm install lowdb` / [npmjs.com/package/lowdb](https://www.npmjs.com/package/lowdb) | state | Lightweight JSON file database for Node.js loops that need structured state without a full database. | A plain `STATE.json` file read and rewritten atomically using a write-then-rename pattern. |
| **tinydb** | `pip install tinydb` / [tinydb.readthedocs.io](https://tinydb.readthedocs.io) | state | Lightweight document store backed by a single JSON file; good for Python loops that need queryable state. | A plain `STATE.json` file with manual `json.load`/`json.dump`. |

---

## Notes for borrowers

- **Always check the license** of any tool listed here before bundling it into a
  commercial loop. Licenses are noted on the linked project pages.
- **Pin versions** in your loop's install script so a dependency upgrade does
  not silently change behavior between runs.
- **Listing here does not imply endorsement or derivation** — these are options
  to evaluate, not requirements to install. The search sub-agent returns a
  shortlist; the operator decides which (if any) to wire in.
