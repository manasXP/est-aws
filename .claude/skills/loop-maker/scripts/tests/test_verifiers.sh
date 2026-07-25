#!/usr/bin/env bash
# scripts/tests/test_verifiers.sh
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; else echo "  ✗ $3 (got $1 want $2)"; fail=1; fi; }

bash "$DIR/verifier_template.sh" "tautology" true >/dev/null 2>&1; check "$?" "0" "passing predicate exits 0"
bash "$DIR/verifier_template.sh" "falsity" false >/dev/null 2>&1; check "$?" "1" "failing predicate exits 1"
bash "$DIR/verifier_template.sh" >/dev/null 2>&1; check "$?" "2" "misuse exits 2"
bash "$DIR/verify_example.sh" 0 >/dev/null 2>&1; check "$?" "0" "example: 0 items left passes"
bash "$DIR/verify_example.sh" 3 >/dev/null 2>&1; check "$?" "1" "example: 3 items left fails"

[ "$fail" = "0" ] && echo "ALL PASS" || { echo "FAILURES"; exit 1; }
