#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
READY_TASK="TASK-${SUFFIX}1"
BLOCKED_TASK="TASK-${SUFFIX}2"
INVALID_TASK="TASK-${SUFFIX}3"
MISSING_TASK="TASK-${SUFFIX}9"

cleanup() {
  rm -rf \
    "$RUNS_DIR/$READY_TASK" \
    "$RUNS_DIR/$BLOCKED_TASK" \
    "$RUNS_DIR/$INVALID_TASK"
}
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  cleanup
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "[FAIL] $message: expected '$expected' in $file"
    echo "----- $file -----"
    cat "$file"
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  local message="$3"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "[FAIL] $message: unexpected '$unexpected' in $file"
    echo "----- $file -----"
    cat "$file"
    exit 1
  fi
}

create_ready_task() {
  mkdir -p "$RUNS_DIR/$READY_TASK"
  cat > "$RUNS_DIR/$READY_TASK/status.yaml" <<YAML
task_id: $READY_TASK
phase: assigned
state: assigned
iteration: 1
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history:
  - phase: "pending -> assigned"
    agent: pm
    reason: "Implementation ready"
YAML
  cat > "$RUNS_DIR/$READY_TASK/dev-output.yaml" <<'YAML'
summary: "ready task output"
artifacts:
  - path: "service/example.go"
    action: modified
next_action:
  agent: reviewer
  reason: "ready"
blockers: []
YAML
}

create_blocked_task() {
  mkdir -p "$RUNS_DIR/$BLOCKED_TASK"
  cat > "$RUNS_DIR/$BLOCKED_TASK/status.yaml" <<YAML
task_id: $BLOCKED_TASK
phase: blocked
state: blocked
iteration: 2
current_agent: dev-2
assignment:
  primary: dev-2
  parallel: false
ready: false
blocked_on:
  - $READY_TASK
waiting_for:
  - "upstream review"
created_at: "2026-05-13"
updated_at: "2026-05-13"
history:
  - phase: "assigned -> blocked"
    agent: orchestrator
    reason: "Waiting on upstream"
YAML
}

create_invalid_task() {
  mkdir -p "$RUNS_DIR/$INVALID_TASK"
  cat > "$RUNS_DIR/$INVALID_TASK/status.yaml" <<YAML
task_id: $INVALID_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: robot
YAML
}

create_ready_task
create_blocked_task
create_invalid_task

echo "== Scenario 1: all-task status summary =="
"$RUN_AGENT" status >/tmp/office-status-all.log 2>&1
assert_contains /tmp/office-status-all.log "$READY_TASK" "all-task status should include ready task"
assert_contains /tmp/office-status-all.log "phase=assigned" "ready task should show phase"
assert_contains /tmp/office-status-all.log "next=./run-agent.sh $READY_TASK dev" "ready task should show next command"
assert_contains /tmp/office-status-all.log "$BLOCKED_TASK" "all-task status should include blocked task"
assert_contains /tmp/office-status-all.log "blocked_on=$READY_TASK" "blocked task should show dependency"
assert_contains /tmp/office-status-all.log "validation=fail" "invalid task should show validation failure"

echo "== Scenario 2: single-task status summary =="
"$RUN_AGENT" status "$BLOCKED_TASK" >/tmp/office-status-single.log 2>&1
assert_contains /tmp/office-status-single.log "Task: $BLOCKED_TASK" "single-task status should include header"
assert_contains /tmp/office-status-single.log "Phase: blocked" "single-task status should show phase"
assert_contains /tmp/office-status-single.log "Blocked on: $READY_TASK" "single-task status should show blocked_on"
assert_contains /tmp/office-status-single.log "Waiting for: upstream review" "single-task status should show waiting_for"
assert_contains /tmp/office-status-single.log "Next: blocked" "blocked task should not suggest dispatch"
assert_not_contains /tmp/office-status-single.log "pm-output.yaml" "single-task status should stay concise"

echo "== Scenario 3: missing task exits non-zero =="
if "$RUN_AGENT" status "$MISSING_TASK" >/tmp/office-status-missing.log 2>&1; then
  echo "[FAIL] missing task should exit non-zero"
  exit 1
fi
assert_contains /tmp/office-status-missing.log "Task not found: $MISSING_TASK" "missing task should be clear"

SUITE_DONE=1
echo "[PASS] status command integration scenarios passed"
