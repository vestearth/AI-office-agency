#!/usr/bin/env bash
# N2: a runner crash must leave a record (a runner_failed meta event with the
# exit code) and a persisted transcript — not just a dangling prompt_assembly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
RUNS_DIR="$ROOT/runs"
BIN="$(mktemp -d)"
T="TASK-N2$$"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  rm -rf "$BIN" "$RUNS_DIR/$T"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

# Fake codex that crashes with a non-switchable error.
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
echo "boom: unexpected internal error"
exit 1
SH
chmod +x "$BIN/codex"

mkdir -p "$RUNS_DIR/$T"
cat > "$RUNS_DIR/$T/status.yaml" <<YAML
task_id: $T
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
echo "# task" > "$RUNS_DIR/$T/task.md"
cat > "$RUNS_DIR/$T/pm-output.yaml" <<'YAML'
summary: plan
title: N2
next_action: { agent: dev, reason: implement }
blockers: []
YAML

rc=0
PATH="$BIN:$PATH" "$DRIVER" "$T" dev codex >/tmp/n2.log 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] || fail "N2: a crashing runner should make the driver exit non-zero"

# runner_failed event recorded in meta.yaml (with exit code).
ruby -ryaml -e '
m = YAML.safe_load(File.read(ARGV[0])) || {}
ev = (m["events"] || []).select { |e| e["type"] == "runner_failed" }
abort "no runner_failed event" if ev.empty?
abort "runner_failed missing exit_code" unless ev.last["details"].to_s.include?("exit_code=1")
' "$RUNS_DIR/$T/meta.yaml" || fail "N2: meta.yaml should record a runner_failed event with exit_code"
ok "N2: runner_failed meta event recorded (with exit_code)"

[[ -f "$RUNS_DIR/$T/dev-runner.log" ]] || fail "N2: the runner transcript should be persisted (dev-runner.log)"
grep -q "boom" "$RUNS_DIR/$T/dev-runner.log" || fail "N2: persisted transcript should contain the runner output"
ok "N2: runner transcript persisted for inspection"

SUITE_DONE=1
echo "[PASS] runner-failure-logged (N2)"
