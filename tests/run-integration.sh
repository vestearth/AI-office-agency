#!/usr/bin/env bash
# Run every integration suite (or only the ones named) and require BOTH a zero
# exit AND the suite's final `[PASS]` / `PASS:` line. Exit 0 alone is not proof:
# on bash 3.2 a suite that aborts under `set -u` can still exit 0 through its
# EXIT trap, having run none of its assertions.
#
#   tests/run-integration.sh                       # all of tests/integration/*.sh
#   tests/run-integration.sh tests/integration/observability.sh ...
#   INTEGRATION_LOG_DIR=/some/dir tests/run-integration.sh   # keep logs there
#   INTEGRATION_SUITE_TIMEOUT=900 tests/run-integration.sh   # per-suite limit, seconds (default 600)
set -euo pipefail
# Job control puts each suite in its own process group, so a timeout or ^C can
# stop the suite together with every child it spawned. Signalling only the
# suite's bash is not enough: bash defers a signal while a foreground child runs.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${INTEGRATION_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG_DIR"
TIMEOUT="${INTEGRATION_SUITE_TIMEOUT:-600}"
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "INTEGRATION_SUITE_TIMEOUT must be a positive number of seconds, got: $TIMEOUT" >&2; exit 2; }
PASS_RE='^(\[PASS\]|PASS:)'

kill_group() { kill -s "$1" -- "-$2" 2>/dev/null || true; }
pid=""; wd=""
on_interrupt() {
  [[ -z "$pid" ]] || kill_group TERM "$pid"
  [[ -z "$wd" ]] || kill_group TERM "$wd"
  exit 130
}
trap on_interrupt INT TERM

if [[ $# -gt 0 ]]; then suites=("$@"); else suites=("$ROOT"/tests/integration/*.sh); fi

pass=0; fail=0; seen="|"
for t in "${suites[@]}"; do
  n="$(basename "$t" .sh)"
  # Same-named suites from different directories get their own log.
  log="$LOG_DIR/$n.log"; k=2
  while [[ "$seen" == *"|$log|"* ]]; do log="$LOG_DIR/$n.$k.log"; k=$((k + 1)); done
  seen="$seen$log|"
  timed_out="$log.timed-out"; rm -f "$timed_out"

  bash "$t" > "$log" 2>&1 < /dev/null &
  pid=$!
  # Watchdog: TERM lets the suite's EXIT trap clean up; KILL is the backstop.
  ( sleep "$TIMEOUT"; : > "$timed_out"; kill -s TERM -- "-$pid" 2>/dev/null
    sleep 10; kill -s KILL -- "-$pid" 2>/dev/null ) > /dev/null 2>&1 &
  wd=$!
  # The braces keep job control's "Terminated" notice out of the runner's output.
  rc=0; { wait "$pid"; } 2>/dev/null || rc=$?
  kill_group TERM "$wd"; wait "$wd" 2>/dev/null || true

  last="$(grep -v '^[[:space:]]*$' "$log" | tail -n 1 || true)"
  if [[ -e "$timed_out" ]]; then
    kill_group KILL "$pid"; rm -f "$timed_out"
    fail=$((fail + 1)); echo "FAIL $n (timed out after ${TIMEOUT}s; log: $log)"
  elif [[ "$rc" -ne 0 ]]; then
    fail=$((fail + 1)); echo "FAIL $n (exit $rc)"
  elif [[ ! "$last" =~ $PASS_RE ]]; then
    fail=$((fail + 1)); echo "FAIL $n (exit 0 but no final PASS line; last line: ${last:-<no output>})"
  else
    pass=$((pass + 1)); echo "ok   $n"
  fi
  pid=""; wd=""
done

echo "pass=$pass fail=$fail logs=$LOG_DIR"
[[ "$fail" -eq 0 ]]
