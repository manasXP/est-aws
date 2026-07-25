#!/usr/bin/env bash
# Dual-write an artifact's status: GitHub Issue is authoritative, est-pm
# frontmatter (when a local file exists) is kept as a synced mirror.
#
#   set-status.sh STR-021 in-progress
#   set-status.sh E01 done
#
# Status vocab: todo · in-progress · done · blocked · deferred
#   todo         -> issue open, no status:* label
#   in-progress  -> issue open, label status:in-progress
#   blocked      -> issue open, label status:blocked
#   deferred     -> issue open, label status:deferred
#   done         -> issue closed, no status:* label
#
# Exit: 0 = updated (GitHub, and frontmatter if a local file was found)
#       1 = no matching GitHub issue (title must start with "<ID> - ")
#       2 = misuse
set -euo pipefail

REPO="manasXP/est-aws"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

ID="${1:-}"; STATUS="${2:-}"
case "$STATUS" in
  todo|in-progress|blocked|deferred|done) ;;
  *) echo "usage: $0 <ID> <todo|in-progress|blocked|deferred|done>" >&2; exit 2 ;;
esac
[ -n "$ID" ] || { echo "usage: $0 <ID> <status>" >&2; exit 2; }

# --- GitHub: find the issue whose title starts with "<ID> - " ------------
NUMBER="$(gh issue list --repo "$REPO" --state all --json number,title --limit 500 \
  | python3 -c "
import json, sys
target = sys.argv[1] + ' - '
for i in json.load(sys.stdin):
    if i['title'].startswith(target):
        print(i['number']); break
" "$ID")"

[ -n "$NUMBER" ] || { echo "no GitHub issue found with title starting '$ID - ' in $REPO" >&2; exit 1; }

for L in status:in-progress status:blocked status:deferred; do
  gh issue edit "$NUMBER" --repo "$REPO" --remove-label "$L" >/dev/null 2>&1 || true
done

if [ "$STATUS" = done ]; then
  gh issue close "$NUMBER" --repo "$REPO" >/dev/null
elif [ "$STATUS" = todo ]; then
  gh issue reopen "$NUMBER" --repo "$REPO" >/dev/null 2>&1 || true
else
  gh issue reopen "$NUMBER" --repo "$REPO" >/dev/null 2>&1 || true
  gh issue edit "$NUMBER" --repo "$REPO" --add-label "status:$STATUS" >/dev/null
fi
echo "github: #$NUMBER -> $STATUS"

# --- est-pm frontmatter mirror, if the file exists locally ---------------
FILE="$(find "$REPO_ROOT/est-pm" -type f -name "$ID*.md" 2>/dev/null | head -1)"
if [ -n "$FILE" ]; then
  TMP="$(mktemp)"
  awk -v s="$STATUS" '
    /^---$/ { n++; print; next }
    n==1 && /^status:/ { print "status: " s; next }
    { print }
  ' "$FILE" > "$TMP" && mv "$TMP" "$FILE"
  echo "frontmatter: $FILE -> $STATUS"
else
  echo "frontmatter: no local est-pm file matching '$ID*.md' (GitHub-only update)"
fi
