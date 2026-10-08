#!/usr/bin/env bash
# Run every integration suite (or only the ones named) and require BOTH a zero
# exit AND the suite's final `[PASS]` / `PASS:` line. Exit 0 alone is not proof:
# on bash 3.2 a suite that aborts under `set -u` can still exit 0 through its
# EXIT trap, having run none of its assertions.
#
#   tests/run-integration.sh                       # all of tests/integration/*.sh
#   tests/run-integration.sh tests/integration/observability.sh ...
#   INTEGRATION_LOG_DIR=/some/dir tests/run-integration.sh   # keep logs there
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${INTEGRATION_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
PASS_RE='^(\[PASS\]|PASS:)'

if [[ $# -gt 0 ]]; then suites=("$@"); else suites=("$ROOT"/tests/integration/*.sh); fi

pass=0; fail=0
for t in "${suites[@]}"; do
  n="$(basename "$t" .sh)"; log="$LOG_DIR/$n.log"
  rc=0; bash "$t" > "$log" 2>&1 < /dev/null || rc=$?
  last="$(grep -v '^[[:space:]]*$' "$log" | tail -n 1 || true)"
  if [[ "$rc" -ne 0 ]]; then
    fail=$((fail + 1)); echo "FAIL $n (exit $rc)"
  elif [[ ! "$last" =~ $PASS_RE ]]; then
    fail=$((fail + 1)); echo "FAIL $n (exit 0 but no final PASS line; last line: ${last:-<no output>})"
  else
    pass=$((pass + 1)); echo "ok   $n"
  fi
done

echo "pass=$pass fail=$fail logs=$LOG_DIR"
[[ "$fail" -eq 0 ]]
