#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT/runs"
TASK="TASK-990001"
TASK_DIR="$RUNS_DIR/$TASK"

cleanup() {
  rm -rf "$TASK_DIR"
}
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  cleanup
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

mkdir -p "$TASK_DIR"

cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: assigned
state: assigned
iteration: 1
current_agent: dev
assignment:
  primary: dev
  parallel: false
created_at: "2026-06-10"
updated_at: "2026-06-10"
history: []
YAML

cat > "$TASK_DIR/pm-output.yaml" <<YAML
task:
  id: "$TASK"
  title: "Add workstream metadata"
  short_name: "workstream-metadata"
  type: feature
  workstream: frontend
  priority: medium
  created_at: "2026-06-10"
scope:
  target_services: []
  affected_files: []
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
  reason: "ready"
blockers: []
YAML

ruby "$ROOT/validate-yaml.rb" "$TASK" >/tmp/workstream-valid.log

perl -0pi -e 's/workstream: frontend/workstream: mobile/' "$TASK_DIR/pm-output.yaml"

if ruby "$ROOT/validate-yaml.rb" "$TASK" >/tmp/workstream-invalid.log 2>&1; then
  echo "[FAIL] invalid workstream should fail validation"
  exit 1
fi

grep -Fq "task.workstream" /tmp/workstream-invalid.log || {
  echo "[FAIL] invalid workstream error should mention task.workstream"
  cat /tmp/workstream-invalid.log
  exit 1
}

SUITE_DONE=1
echo "[PASS] workstream-contract"
