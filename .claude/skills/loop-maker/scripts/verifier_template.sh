#!/usr/bin/env bash
# Generic deterministic verifier — the maker/checker split in one file.
# A loop is only as trustworthy as its checker, so the check is a PROGRAM with a
# binary verdict, not a model's opinion. Wrap any predicate that exits 0 when the
# condition holds and non-zero when it does not.
#
# Usage: verifier_template.sh "<description>" <predicate-command> [args...]
# Exit:  0 = holds (loop may stop) · 1 = does not (iterate) · 2 = misuse
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "usage: $0 \"<description>\" <predicate-command> [args...]" >&2
  exit 2
fi
description="$1"; shift
if "$@"; then
  echo "PASS: $description"; exit 0
else
  status=$?
  echo "FAIL: $description (predicate exited $status)" >&2; exit 1
fi
