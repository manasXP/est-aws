#!/usr/bin/env bash
# Deterministic half of story discovery: order the queue and evaluate the exit
# predicate. Dependency *vetoes* are prose and stay with the model (see SKILL.md);
# this script never reads the "## Dependencies" section.
#
#   next-story.sh           # print next todo story path (milestone, then STR number)
#   next-story.sh --count   # count todo stories — 0 means queue drained
#   next-story.sh --list    # all todo stories in order
# Exit: 0 = a story was printed / count is non-zero · 1 = queue drained · 2 = misuse
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
STORIES="${EST_STORIES:-$REPO_ROOT/est-pm/Stories}"
[ -d "$STORIES" ] || { echo "story queue not found: $STORIES" >&2; exit 2; }

# Sort by milestone dir then filename; STR decade-blocking makes numeric order
# match epic order (EST-PM/Stories/README.md).
todo() {
  find "$STORIES"/M[0-5] -name 'STR-*.md' 2>/dev/null | sort | while read -r f; do
    # status: from frontmatter only — stop at the closing delimiter so a "status:"
    # mentioned in the body can never be mistaken for the real field.
    awk '/^---$/{n++; next} n==1 && /^status:[[:space:]]*todo[[:space:]]*$/{print; exit} n>=2{exit}' "$f" \
      | grep -q . && echo "$f"
  done
}

case "${1:-}" in
  --count) todo | wc -l | tr -d ' ' ;;
  --list)  todo ;;
  # sed -n 1p, not head -1: head closes the pipe early, the producer takes
  # SIGPIPE, and `pipefail` turns that into a silently empty result.
  "")      first="$(todo | sed -n '1p')"; [ -n "$first" ] || exit 1; echo "$first" ;;
  *)       echo "usage: $0 [--count|--list]" >&2; exit 2 ;;
esac
