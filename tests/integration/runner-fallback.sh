#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
FALLBACK_TASK="TASK-${SUFFIX}F"
CURSOR_TASK="TASK-${SUFFIX}C"
NONTRIGGER_TASK="TASK-${SUFFIX}N"
AUTO_FAIL_TASK="TASK-${SUFFIX}A"
TEST_BIN_DIR="$(mktemp -d)"
CALL_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$RUNS_DIR/$FALLBACK_TASK" "$RUNS_DIR/$CURSOR_TASK" "$RUNS_DIR/$NONTRIGGER_TASK" "$RUNS_DIR/$AUTO_FAIL_TASK" "$TEST_BIN_DIR" "$CALL_DIR"
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

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[FAIL] $message: expected '$expected' got '$actual'"
    exit 1
  fi
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if ! grep -Fq "$pattern" "$file"; then
    echo "[FAIL] $message: missing '$pattern' in $file"
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

write_ready_task() {
  local task_id="$1"
  mkdir -p "$RUNS_DIR/$task_id"
  cat > "$RUNS_DIR/$task_id/status.yaml" <<YAML
task_id: $task_id
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
  cat > "$RUNS_DIR/$task_id/pm-output.yaml" <<'YAML'
task:
  id: "TASK-FB"
  title: "Runner fallback"
  short_name: "runner-fallback"
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
  cat > "$RUNS_DIR/$task_id/dev-output.yaml" <<'YAML'
summary: "fallback handoff"
artifacts:
  - path: "foo"
    action: modified
next_action:
  agent: reviewer
  reason: "ready for review"
blockers: []
YAML
}

cat > "$TEST_BIN_DIR/codex" <<'SH'
#!/usr/bin/env bash
count_file="$RUNNER_FALLBACK_CALL_DIR/codex.count"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
echo "$count" > "$count_file"
echo "insufficient_quota: Codex quota exhausted" >&2
exit 42
SH
chmod +x "$TEST_BIN_DIR/codex"

cat > "$TEST_BIN_DIR/cursor" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$RUNNER_FALLBACK_CALL_DIR/cursor.args"
if [[ "${RUNNER_FALLBACK_CURSOR_FAIL:-false}" == "true" ]]; then
  echo "rate limit: Cursor Agent quota exhausted" >&2
  exit 43
fi
exit 0
SH
chmod +x "$TEST_BIN_DIR/cursor"

echo "== Scenario 1: Codex quota switches to Cursor Agent =="
write_ready_task "$FALLBACK_TASK"
RUNNER_FALLBACK_CALL_DIR="$CALL_DIR" PATH="$TEST_BIN_DIR:$PATH" "$RUN_AGENT" "$FALLBACK_TASK" dev codex >/tmp/runner-fallback.log 2>&1

assert_eq "3" "$(cat "$CALL_DIR/codex.count")" "codex should run initial attempt plus two retries"
assert_contains "$CALL_DIR/cursor.args" "agent -p" "cursor-agent fallback should invoke cursor agent"
assert_contains "$RUNS_DIR/$FALLBACK_TASK/meta.yaml" "type: runner_switch" "runner switch should be audited"
assert_contains "$RUNS_DIR/$FALLBACK_TASK/meta.yaml" "from=codex to=cursor-agent" "switch audit should record from/to"
assert_eq "in_review" "$(yaml_value "$RUNS_DIR/$FALLBACK_TASK/status.yaml" "phase")" "successful fallback should still sync status"

echo "== Scenario 2: Cursor Agent quota switches to Cursor prompt =="
write_ready_task "$CURSOR_TASK"
rm -f "$CALL_DIR/codex.count" "$CALL_DIR/cursor.args"
RUNNER_FALLBACK_CALL_DIR="$CALL_DIR" RUNNER_FALLBACK_CURSOR_FAIL=true PATH="$TEST_BIN_DIR:$PATH" "$RUN_AGENT" "$CURSOR_TASK" dev codex >/tmp/runner-cursor-prompt.log 2>&1

assert_eq "3" "$(cat "$CALL_DIR/codex.count")" "codex should run initial attempt plus two retries before cursor-agent"
assert_contains "$CALL_DIR/cursor.args" "agent -p" "cursor-agent should be tried before interactive cursor"
assert_contains "$RUNS_DIR/$CURSOR_TASK/meta.yaml" "from=cursor-agent to=cursor" "interactive switch should be audited"
if [[ ! -f "$RUNS_DIR/$CURSOR_TASK/.cursor-prompt.md" ]]; then
  echo "[FAIL] cursor fallback should generate .cursor-prompt.md"
  exit 1
fi

echo "== Scenario 3: Non-trigger failure propagates exit code =="
# Create a codex stub that fails with a non-trigger error (no quota/auth keywords)
NONTRIGGER_BIN_DIR="$(mktemp -d)"
cat > "$NONTRIGGER_BIN_DIR/codex" <<'SH'
#!/usr/bin/env bash
echo "FATAL: unexpected internal compiler error" >&2
exit 1
SH
chmod +x "$NONTRIGGER_BIN_DIR/codex"

write_ready_task "$NONTRIGGER_TASK"
nontrigger_status=0
PATH="$NONTRIGGER_BIN_DIR:$PATH" "$RUN_AGENT" "$NONTRIGGER_TASK" dev codex >/tmp/runner-nontrigger.log 2>&1 || nontrigger_status=$?

if [[ "$nontrigger_status" -eq 0 ]]; then
  echo "[FAIL] non-trigger runner failure should propagate non-zero exit code, got 0"
  exit 1
fi
# Status should NOT have advanced (still assigned, not in_review)
actual_phase="$(yaml_value "$RUNS_DIR/$NONTRIGGER_TASK/status.yaml" "phase")"
assert_eq "assigned" "$actual_phase" "status should not advance after non-trigger failure"

rm -rf "$NONTRIGGER_BIN_DIR"

echo "== Scenario 4: Auto mode does not advance state machine on runner failure =="
# Create a codex stub that fails with a non-trigger error for auto mode
AUTO_FAIL_BIN_DIR="$(mktemp -d)"
cat > "$AUTO_FAIL_BIN_DIR/codex" <<'SH'
#!/usr/bin/env bash
echo "FATAL: segfault in sandbox" >&2
exit 1
SH
chmod +x "$AUTO_FAIL_BIN_DIR/codex"

# Write a task that auto mode would start from pm
mkdir -p "$RUNS_DIR/$AUTO_FAIL_TASK"
cat > "$RUNS_DIR/$AUTO_FAIL_TASK/status.yaml" <<YAML
task_id: $AUTO_FAIL_TASK
phase: pending
state: pending
iteration: 0
current_agent: pm
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
cat > "$RUNS_DIR/$AUTO_FAIL_TASK/task.md" <<'MD'
Test task for auto-fail scenario.
MD

auto_status=0
PATH="$AUTO_FAIL_BIN_DIR:$PATH" "$RUN_AGENT" "$AUTO_FAIL_TASK" auto codex >/tmp/runner-auto-fail.log 2>&1 || auto_status=$?

if [[ "$auto_status" -eq 0 ]]; then
  echo "[FAIL] auto mode should exit non-zero when runner fails, got 0"
  exit 1
fi

rm -rf "$AUTO_FAIL_BIN_DIR"

SUITE_DONE=1
echo "[PASS] runner fallback integration scenarios passed"
