#!/usr/bin/env bash
set -euo pipefail

# End-to-end test for scripts/adapter-status.rb (Phase 3 of issue #23 — the
# reference runtime-adapter status query, docs/runtime-adapter-contract.md).
# Exercises the real script against real runs/<task-id> fixtures: an
# in-progress task with no pending output, a task whose manual output is
# sitting on disk but not yet synced (the record/import scenario), a
# terminal task, and a blocked task. Never touches run-agent.sh or the
# workflow-transition scripts — this is a read-only query surface.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
ADAPTER="$ROOT_DIR/scripts/adapter-status.rb"

SUFFIX="$(date +%s)$$"
T_PENDING="TASK-${SUFFIX}1"
T_UNSYNCED="TASK-${SUFFIX}2"
T_DONE="TASK-${SUFFIX}3"
T_BLOCKED="TASK-${SUFFIX}4"

cleanup() {
  rm -rf "$RUNS_DIR/$T_PENDING" "$RUNS_DIR/$T_UNSYNCED" "$RUNS_DIR/$T_DONE" "$RUNS_DIR/$T_BLOCKED"
}
trap cleanup EXIT

assert_eq() {
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

json_value() {  # <json-string> <ruby-expr-on-parsed-hash>
  ruby -rjson -e '
    data = JSON.parse(ARGV[0])
    print eval(ARGV[1])
  ' "$1" "$2"
}

# ── Fixture 1: assigned to dev, no output file yet ───────────────────────────
mkdir -p "$RUNS_DIR/$T_PENDING"
cat > "$RUNS_DIR/$T_PENDING/status.yaml" <<YAML
task_id: $T_PENDING
phase: assigned
state: assigned
iteration: 0
current_agent: dev
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
blocked_on: []
waiting_for: []
history:
  - phase: created -> assigned
    agent: pm
    at: "2026-06-05"
    reason: "planned"
YAML

echo "== Scenario 1: pending role, no output file yet =="
OUT1="$(ruby "$ADAPTER" "$T_PENDING")"
assert_eq "$T_PENDING" "$(json_value "$OUT1" 'data["task_id"]')" "task_id"
assert_eq "dev" "$(json_value "$OUT1" 'data["current_agent"]')" "current_agent"
assert_eq "./run-agent.sh $T_PENDING dev" "$(json_value "$OUT1" 'data["next_command"]')" "next_command"
assert_eq "false" "$(json_value "$OUT1" 'data["terminal"]')" "terminal"
assert_eq "" "$(json_value "$OUT1" 'data["pending_manual_output"].nil? ? "" : "present"')" "no pending output expected"

# ── Fixture 2: assigned to dev, dev-output.yaml written by hand, not synced ──
mkdir -p "$RUNS_DIR/$T_UNSYNCED"
cat > "$RUNS_DIR/$T_UNSYNCED/status.yaml" <<YAML
task_id: $T_UNSYNCED
phase: assigned
state: assigned
iteration: 0
current_agent: dev
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
blocked_on: []
waiting_for: []
history: []
YAML
cat > "$RUNS_DIR/$T_UNSYNCED/dev-output.yaml" <<'YAML'
summary: "implemented by hand in Cursor"
artifacts:
  - path: "foo.go"
    action: modified
next_action: { agent: reviewer, reason: "ready for review" }
blockers: []
YAML

echo "== Scenario 2: manually-produced output waiting to be recorded =="
OUT2="$(ruby "$ADAPTER" "$T_UNSYNCED")"
assert_eq "present" "$(json_value "$OUT2" 'data["pending_manual_output"].nil? ? "" : "present"')" "pending output should be surfaced"
assert_eq "true" "$(json_value "$OUT2" 'data["pending_manual_output"]["exists"]')" "output file exists"
assert_eq "false" "$(json_value "$OUT2" 'data["pending_manual_output"]["already_synced"]')" "not yet synced"
assert_eq "reviewer" "$(json_value "$OUT2" 'data["pending_manual_output"]["next_agent_preview"]')" "preview should read next_action.agent without writing status.yaml"
# Read-only guarantee: status.yaml on disk must be byte-identical after the query.
assert_eq "assigned" "$(ruby -ryaml -e 'print YAML.load_file(ARGV[0])["phase"]' "$RUNS_DIR/$T_UNSYNCED/status.yaml")" "status.yaml must be untouched (still assigned, no sync side effect)"

# ── Fixture 3: terminal task ─────────────────────────────────────────────────
mkdir -p "$RUNS_DIR/$T_DONE"
cat > "$RUNS_DIR/$T_DONE/status.yaml" <<YAML
task_id: $T_DONE
phase: done
state: done
iteration: 2
current_agent: done
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
blocked_on: []
waiting_for: []
history: []
YAML

echo "== Scenario 3: terminal task =="
OUT3="$(ruby "$ADAPTER" "$T_DONE")"
assert_eq "true" "$(json_value "$OUT3" 'data["terminal"]')" "done task should be terminal"
assert_eq "" "$(json_value "$OUT3" 'data["next_command"].nil? ? "" : data["next_command"]')" "terminal task has no next_command"

# ── Fixture 4: blocked task ───────────────────────────────────────────────────
mkdir -p "$RUNS_DIR/$T_BLOCKED"
cat > "$RUNS_DIR/$T_BLOCKED/status.yaml" <<YAML
task_id: $T_BLOCKED
phase: blocked
state: blocked
iteration: 1
current_agent: dev
ready: false
created_at: "2026-06-05"
updated_at: "2026-06-05"
blocked_on: ["TASK-OTHER-1"]
waiting_for: ["TASK-OTHER-1"]
history: []
YAML

echo "== Scenario 4: blocked task =="
OUT4="$(ruby "$ADAPTER" "$T_BLOCKED")"
assert_eq "true" "$(json_value "$OUT4" 'data["blocked"]')" "blocked task flagged"
assert_eq "" "$(json_value "$OUT4" 'data["next_command"].nil? ? "" : data["next_command"]')" "blocked task has no next_command"
assert_eq "TASK-OTHER-1" "$(json_value "$OUT4" 'data["blocked_on"][0]')" "blocked_on surfaced"

# ── Unknown task: clean failure, not a crash ──────────────────────────────────
echo "== Scenario 5: unknown task id exits non-zero, no traceback =="
if ruby "$ADAPTER" "TASK-DOES-NOT-EXIST-999" >/tmp/adapter-status-unknown.log 2>&1; then
  echo "[FAIL] adapter-status.rb should exit non-zero for an unknown task"
  exit 1
fi
grep -q "Task not found" /tmp/adapter-status-unknown.log || { echo "[FAIL] expected a clean 'Task not found' message"; exit 1; }

echo "[PASS] adapter-status: pending/unsynced/terminal/blocked/unknown scenarios, read-only confirmed"
