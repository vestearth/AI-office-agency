#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
BLOCKED_TASK="TASK-${SUFFIX}1"
UPSTREAM_TASK="TASK-${SUFFIX}2"
HANDOFF_TASK="TASK-${SUFFIX}3"

cleanup() {
  rm -rf "$RUNS_DIR/$BLOCKED_TASK" "$RUNS_DIR/$UPSTREAM_TASK" "$RUNS_DIR/$HANDOFF_TASK"
}
trap cleanup EXIT

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[FAIL] $message: expected '$expected' got '$actual'"
    exit 1
  fi
}

yaml_value() {
  local file="$1"
  local key="$2"
  ruby - "$file" "$key" <<'RUBY'
require "yaml"
require "date"
path, key = ARGV
data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
value = key.split(".").reduce(data) { |memo, part| memo.is_a?(Hash) ? memo[part] : nil }
puts value.to_s
RUBY
}

echo "== Scenario 1: blocked task should not dispatch =="
mkdir -p "$RUNS_DIR/$BLOCKED_TASK" "$RUNS_DIR/$UPSTREAM_TASK"
cat > "$RUNS_DIR/$BLOCKED_TASK/status.yaml" <<YAML
task_id: $BLOCKED_TASK
phase: blocked
state: blocked
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
blocked_on:
  - $UPSTREAM_TASK
waiting_for:
  - contract_freeze
ready: false
created_at: "2026-04-23"
updated_at: "2026-04-23"
history: []
YAML
cat > "$RUNS_DIR/$UPSTREAM_TASK/status.yaml" <<YAML
task_id: $UPSTREAM_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-04-23"
updated_at: "2026-04-23"
history: []
YAML
cat > "$RUNS_DIR/$BLOCKED_TASK/pm-output.yaml" <<'YAML'
task:
  id: "TASK-DEP"
  title: "Dependency dispatch guard"
  short_name: "dep-guard"
  type: feature
  priority: high
scope: {}
description: "test"
acceptance_criteria: []
plan: {}
assignment:
  primary: dev
  parallel: false
  reason: "test"
summary: "test"
artifacts: []
next_action:
  agent: dev
  reason: "test"
blockers: []
YAML
if "$RUN_AGENT" "$BLOCKED_TASK" dev cursor >/tmp/dep-guard.log 2>&1; then
  echo "[FAIL] blocked task dispatched unexpectedly"
  exit 1
fi

echo "== Scenario 2: unblock when upstream done =="
cat > "$RUNS_DIR/$UPSTREAM_TASK/status.yaml" <<YAML
task_id: $UPSTREAM_TASK
phase: done
state: done
iteration: 1
current_agent: done
assignment:
  primary: dev
  parallel: false
ready: false
created_at: "2026-04-23"
updated_at: "2026-04-23"
history: []
YAML
"$RUN_AGENT" "$BLOCKED_TASK" dev cursor >/tmp/dep-unblock.log 2>&1
assert_eq "assigned" "$(yaml_value "$RUNS_DIR/$BLOCKED_TASK/status.yaml" "phase")" "blocked task should transition to assigned"
assert_eq "true" "$(yaml_value "$RUNS_DIR/$BLOCKED_TASK/status.yaml" "ready")" "blocked task should become ready"

echo "== Scenario 3: dev handoff should route to reviewer queue phase =="
mkdir -p "$RUNS_DIR/$HANDOFF_TASK"
cat > "$RUNS_DIR/$HANDOFF_TASK/status.yaml" <<YAML
task_id: $HANDOFF_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-04-23"
updated_at: "2026-04-23"
history: []
YAML
cat > "$RUNS_DIR/$HANDOFF_TASK/pm-output.yaml" <<'YAML'
task:
  id: "TASK-HF"
  title: "Handoff transition"
  short_name: "handoff-transition"
  type: feature
  priority: high
scope: {}
description: "test"
acceptance_criteria: []
plan: {}
assignment:
  primary: dev
  parallel: false
  reason: "test"
summary: "test"
artifacts: []
next_action:
  agent: dev
  reason: "test"
blockers: []
YAML
cat > "$RUNS_DIR/$HANDOFF_TASK/dev-output.yaml" <<'YAML'
summary: "handoff"
artifacts:
  - path: "foo"
    action: modified
next_action:
  agent: reviewer
  reason: "ready for review"
blockers: []
YAML
"$RUN_AGENT" "$HANDOFF_TASK" dev cursor >/tmp/dep-handoff.log 2>&1
assert_eq "in_review" "$(yaml_value "$RUNS_DIR/$HANDOFF_TASK/status.yaml" "phase")" "dev handoff should set reviewer queue phase"
assert_eq "reviewer" "$(yaml_value "$RUNS_DIR/$HANDOFF_TASK/status.yaml" "current_agent")" "next agent should be reviewer"

echo "[PASS] dependency policy integration scenarios passed"
