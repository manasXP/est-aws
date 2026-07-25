#!/usr/bin/env bash
# Regression suite for the story-tdd verifier.
#
# The verifier is the loop's trust anchor: every "this story is done" claim
# rests on it. Run this after ANY edit to it. A verifier that only ever says
# PASS proves nothing, so three of the four cases are attacks.
#
#   ./test_verifier.sh          # exit 0 = all scenarios behave correctly
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../../verifier"
SRC="${EST_AWS:-$HOME/code/est-aws}"
[ -x "$V" ] || { echo "verifier not executable: $V" >&2; exit 2; }
[ -d "$SRC/.git" ] || { echo "est-aws not found: $SRC (set EST_AWS)" >&2; exit 2; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git clone -q "$SRC" "$T/fixture"
cd "$T/fixture"
git config user.email t@test; git config user.name test
[ -d "$SRC/node_modules" ] && ln -s "$SRC/node_modules" node_modules

pass=0; fail=0
check() { # check <label> <expected-exit> <story>
  local label="$1" want="$2" id="$3" got
  set +e; "$V" "$id" "$T/fixture" >/dev/null 2>&1; got=$?; set -e
  if [ "$got" = "$want" ]; then printf '  ok   %-32s (exit %s)\n' "$label" "$got"; pass=$((pass+1))
  else printf '  FAIL %-32s (exit %s, wanted %s)\n' "$label" "$got" "$want"; fail=$((fail+1)); fi
}

# 1. Honest red-then-green — the only case that may pass.
git checkout -qb story/STR-999
cat > test/str999.test.ts <<'EOF'
import { it, expect } from 'vitest'
import { addPaise } from '../aws-blocks/money'
it('sums decimal strings exactly', () => expect(addPaise('1250.00','0.50')).toBe('1250.50'))
EOF
git add -A && git commit -qm "STR-999 Red: money addition"
cat > aws-blocks/money.ts <<'EOF'
export function addPaise(a: string, b: string): string {
  const toP = (s: string) => { const [i, f = ''] = s.split('.'); return BigInt(i + f.padEnd(2, '0')) }
  const t = toP(a) + toP(b)
  return `${t / 100n}.${String(t % 100n).padStart(2, '0')}`
}
EOF
git add -A && git commit -qm "STR-999 Green: exact decimal addition"
check "honest red-then-green" 0 STR-999

# 2. Implementation smuggled into the Red commit — defeats the whole gate.
git checkout -q main && git checkout -qb story/STR-998
: > aws-blocks/m998.ts
echo 'import { it, expect } from "vitest"; it("x", () => expect(1).toBe(2))' > test/str998.test.ts
git add -A && git commit -qm "STR-998 Red: tests"
git commit -q --allow-empty -m "STR-998 Green: impl"
check "impl smuggled into Red commit" 1 STR-998

# 3. Vacuous red — a "failing test" that already passes.
git checkout -q main && git checkout -qb story/STR-997
echo 'import { it, expect } from "vitest"; it("trivial", () => expect(1).toBe(1))' > test/str997.test.ts
git add -A && git commit -qm "STR-997 Red: tests"
git commit -q --allow-empty -m "STR-997 Green: impl"
check "vacuous red (test already passes)" 1 STR-997

# 4. A pre-existing broken test supplying the non-zero exit while the story's
#    own new test quietly passes. This is why the red run is scoped to the
#    files the Red commit touched.
git checkout -q main && git checkout -qb story/STR-996
echo 'import { it, expect } from "vitest"; it("broken", () => expect(1).toBe(9))' > test/preexisting.test.ts
git add -A && git commit -qm "unrelated: pre-existing failing test"
echo 'import { it, expect } from "vitest"; it("passes", () => expect(1).toBe(1))' > test/str996.test.ts
git add -A && git commit -qm "STR-996 Red: tests"
git commit -q --allow-empty -m "STR-996 Green: impl"
check "red masked by pre-existing failure" 1 STR-996

# 5. Misuse.
check "unknown story id" 1 STR-000

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
