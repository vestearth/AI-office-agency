#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
TASKS_DIR="$ROOT_DIR/tasks"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
VERIFY_TASK="TASK-${SUFFIX}1"
DONE_DEP_TASK="TASK-${SUFFIX}2"
BLOCKED_TASK="TASK-${SUFFIX}3"
INVALID_TASK="TASK-${SUFFIX}4"
MISSING_DEP_TASK="TASK-${SUFFIX}5"
MISSING_TASK="TASK-${SUFFIX}9"

cleanup() {
  rm -rf \
    "$RUNS_DIR/$VERIFY_TASK" \
    "$RUNS_DIR/$DONE_DEP_TASK" \
    "$RUNS_DIR/$BLOCKED_TASK" \
    "$RUNS_DIR/$INVALID_TASK" \
    "$RUNS_DIR/$MISSING_DEP_TASK"
}
trap cleanup EXIT

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

assert_no_dir() {
  local path="$1"
  local message="$2"
  if [[ -d "$path" ]]; then
    echo "[FAIL] $message: unexpected directory $path"
    exit 1
  fi
}

create_verify_task() {
  mkdir -p "$RUNS_DIR/$VERIFY_TASK"
  cat > "$RUNS_DIR/$VERIFY_TASK/status.yaml" <<YAML
task_id: $VERIFY_TASK
phase: in_review
state: in_review
iteration: 2
current_agent: reviewer
assignment:
  primary: dev-2
  parallel: false
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
  cat > "$RUNS_DIR/$VERIFY_TASK/task.md" <<'MD'
# Add order callback proto validation

Modify Games-Labs-Order callback handling and update proto gateway mappings.
MD
  cat > "$RUNS_DIR/$VERIFY_TASK/pm-output.yaml" <<YAML
task:
  id: "$VERIFY_TASK"
  title: "Add order callback proto validation"
  short_name: "order-callback-validation"
  type: feature
  priority: high
scope:
  target_services:
    - service: Games-Labs-Order
      reason: "callback logic changes"
  affected_files:
    - path: Games-Labs-Order/proto/order.proto
      action: modify
      description: "contract update"
    - path: Games-Labs-Order/internal/callback.go
      action: modify
      description: "callback validation"
description: "test"
acceptance_criteria: []
plan: {}
assignment:
  primary: dev-2
  parallel: false
  reason: "cross-cutting"
summary: "test"
artifacts: []
next_action:
  agent: dev-2
  reason: "ready"
blockers: []
YAML
  cat > "$RUNS_DIR/$VERIFY_TASK/dev-2-output.yaml" <<'YAML'
summary: "implemented callback validation"
artifacts:
  - path: "Games-Labs-Order/proto/order.proto"
    action: modified
  - path: "Games-Labs-Order/internal/callback.go"
    action: modified
  - path: ".github/workflows/ci.yml"
    action: modified
next_action:
  agent: reviewer
  reason: "ready"
blockers: []
YAML
}

create_cleanup_tasks() {
  mkdir -p "$RUNS_DIR/$DONE_DEP_TASK" "$RUNS_DIR/$BLOCKED_TASK" "$RUNS_DIR/$INVALID_TASK" "$RUNS_DIR/$MISSING_DEP_TASK"
  cat > "$RUNS_DIR/$DONE_DEP_TASK/status.yaml" <<YAML
task_id: $DONE_DEP_TASK
phase: done
state: done
iteration: 1
current_agent: done
ready: false
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
  cat > "$RUNS_DIR/$BLOCKED_TASK/status.yaml" <<YAML
task_id: $BLOCKED_TASK
phase: blocked
state: blocked
iteration: 1
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: false
blocked_on:
  - $DONE_DEP_TASK
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
  cat > "$RUNS_DIR/$INVALID_TASK/status.yaml" <<YAML
task_id: $INVALID_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: robot
YAML
  cat > "$RUNS_DIR/$MISSING_DEP_TASK/status.yaml" <<YAML
task_id: $MISSING_DEP_TASK
phase: blocked
state: blocked
iteration: 1
current_agent: dev-2
assignment:
  primary: dev-2
  parallel: false
ready: false
blocked_on:
  - TASK-999999
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
}

create_verify_task
create_cleanup_tasks

# Intake needs a registered prefix once office.team.yaml has entries. Scope one
# to the call via env so the result never depends on the developer's local
# office.config.local.yaml; an empty registry (solo mode) needs no prefix.
INTAKE_PREFIX="$(ruby -ryaml -e '
  d = YAML.safe_load(File.read(ARGV[0])) rescue nil
  k = d.is_a?(Hash) && d["prefixes"].is_a?(Hash) ? d["prefixes"].keys.first : nil
  print k.to_s.upcase
' "$ROOT_DIR/office.team.yaml")"

echo "== Scenario 1: intake preview =="
OFFICE_TASK_PREFIX="$INTAKE_PREFIX" "$RUN_AGENT" intake "Fix critical wallet outage in Games-Labs-Wallet callback error" >/tmp/operator-intake.log 2>&1
assert_contains /tmp/operator-intake.log "Intake preview" "intake should print preview header"
assert_contains /tmp/operator-intake.log "Type: bugfix" "intake should classify bugfix"
assert_contains /tmp/operator-intake.log "Priority: critical" "intake should classify critical priority"
assert_contains /tmp/operator-intake.log "Services: Games-Labs-Wallet" "intake should detect service"
assert_contains /tmp/operator-intake.log "Next: ./run-agent.sh" "intake should suggest next command"
assert_no_dir "$RUNS_DIR/TASK-999999" "intake must not create task directories"

echo "== Scenario 2: verify recommendation =="
"$RUN_AGENT" verify "$VERIFY_TASK" >/tmp/operator-verify.log 2>&1
assert_contains /tmp/operator-verify.log "Verification plan: $VERIFY_TASK" "verify should print task header"
assert_contains /tmp/operator-verify.log "ruby validate-yaml.rb $VERIFY_TASK" "verify should include runtime validation"
assert_contains /tmp/operator-verify.log "make proto" "verify should recommend proto generation"
assert_contains /tmp/operator-verify.log "go test ./Games-Labs-Order/..." "verify should recommend service tests"
assert_contains /tmp/operator-verify.log "scripts/check-service-dependencies.sh" "verify should recommend dependency guard for CI changes"

echo "== Scenario 3: cleanup report =="
"$RUN_AGENT" cleanup >/tmp/operator-cleanup.log 2>&1
assert_contains /tmp/operator-cleanup.log "Office cleanup report" "cleanup should print report header"
assert_contains /tmp/operator-cleanup.log "$INVALID_TASK validation=fail" "cleanup should report validation failure"
assert_contains /tmp/operator-cleanup.log "$BLOCKED_TASK blocked_dependency_done=$DONE_DEP_TASK" "cleanup should report resolved dependency"
assert_contains /tmp/operator-cleanup.log "$MISSING_DEP_TASK blocked_dependency_missing=TASK-999999" "cleanup should report missing dependency"

echo "== Scenario 4: verify missing task exits non-zero =="
if "$RUN_AGENT" verify "$MISSING_TASK" >/tmp/operator-verify-missing.log 2>&1; then
  echo "[FAIL] verify missing task should exit non-zero"
  exit 1
fi
assert_contains /tmp/operator-verify-missing.log "Task not found: $MISSING_TASK" "verify missing task should be clear"

echo "[PASS] operator command integration scenarios passed"
