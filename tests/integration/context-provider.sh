#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
UNAVAILABLE_TASK="TASK-${SUFFIX}1"
AVAILABLE_TASK="TASK-${SUFFIX}2"
EMPTY_TASK="TASK-${SUFFIX}3"
SKIP_TASK="TASK-${SUFFIX}4"
FAIL_TASK="TASK-${SUFFIX}5"
VALIDATE_TASK="TASK-${SUFFIX}6"
STALE_TASK="TASK-${SUFFIX}7"

cleanup() {
  rm -rf \
    "$RUNS_DIR/$UNAVAILABLE_TASK" \
    "$RUNS_DIR/$AVAILABLE_TASK" \
    "$RUNS_DIR/$EMPTY_TASK" \
    "$RUNS_DIR/$SKIP_TASK" \
    "$RUNS_DIR/$FAIL_TASK" \
    "$RUNS_DIR/$VALIDATE_TASK" \
    "$RUNS_DIR/$STALE_TASK" \
    "$TEST_BIN_DIR" \
    "$NO_SOC_BIN_DIR"
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

yaml_event_details() {
  local file="$1"
  local event_type="$2"
  ruby - "$file" "$event_type" <<'RUBY'
require "yaml"
require "date"
path, event_type = ARGV
data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
event = Array(data["events"]).reverse.find { |entry| entry.is_a?(Hash) && entry["type"].to_s == event_type }
puts event ? event["details"].to_s : ""
RUBY
}

create_task() {
  local task_id="$1"
  local title="$2"
  local body="$3"

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
created_at: "2026-05-05"
updated_at: "2026-05-05"
history: []
YAML
  cat > "$RUNS_DIR/$task_id/pm-output.yaml" <<YAML
task:
  id: "$task_id"
  title: "$title"
  short_name: "context-provider"
  type: feature
  priority: medium
scope:
  target_services:
    - service: Games-Labs-Order
      reason: "test"
  affected_files:
    - path: Games-Labs-Order/internal/example.go
      action: modify
      description: "test"
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
  cat > "$RUNS_DIR/$task_id/task.md" <<MD
# $title

$body
MD
}

TEST_BIN_DIR="$(mktemp -d)"
NO_SOC_BIN_DIR="$(mktemp -d)"

# run-agent.sh prefers the in-repo SocratiCode TCP wrapper over the PATH binary,
# and on a developer machine that wrapper connects to a live backend - which
# bypasses the PATH stubbing these scenarios rely on. Point the wrapper at a
# non-existent path so provider availability is governed solely by PATH:
# no socraticode on PATH => unavailable; the TEST_BIN_DIR fake => used/empty/etc.
export SOCRATICODE_WRAPPER="$NO_SOC_BIN_DIR/__no_such_wrapper__"

cat > "$TEST_BIN_DIR/socraticode" <<'SH'
#!/usr/bin/env bash
if [[ "${SOCRATICODE_BEHAVIOR:-used}" == "empty" ]]; then
  exit 0
fi
if [[ "${SOCRATICODE_BEHAVIOR:-used}" == "fail" ]]; then
  echo "index not ready" >&2
  exit 3
fi
if [[ "${SOCRATICODE_BEHAVIOR:-used}" == "stale" ]]; then
  cat <<'CTX'
freshness: stale
confidence: low
queries:
  - "fake stale task query"
relevant_context: []
CTX
  exit 0
fi
cat <<'CTX'
freshness: current
confidence: high
queries:
  - "fake task query"
relevant_context:
  - path: Games-Labs-Order/internal/example.go
    symbol: Example
    reason: Fake indexed context for test
    confidence: medium
CTX
SH
chmod +x "$TEST_BIN_DIR/socraticode"

echo "== Scenario 1: SocratiCode unavailable falls back without failing =="
create_task "$UNAVAILABLE_TASK" "Implement order callback validation" "Modify code in Games-Labs-Order."
PATH="$NO_SOC_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$UNAVAILABLE_TASK" dev cursor >/tmp/context-unavailable.log 2>&1
assert_contains "$RUNS_DIR/$UNAVAILABLE_TASK/.cursor-prompt.md" "--- AI CONTEXT INDEX ---" "prompt should include context section"
assert_contains "$RUNS_DIR/$UNAVAILABLE_TASK/.cursor-prompt.md" "status: unavailable" "prompt should record unavailable provider"
assert_contains "$RUNS_DIR/$UNAVAILABLE_TASK/.cursor-prompt.md" "fallback: repo_search" "prompt should instruct repo-search fallback"
assert_contains "$RUNS_DIR/$UNAVAILABLE_TASK/meta.yaml" "context_provider" "meta should record context provider event"
if [[ "$(yaml_event_details "$RUNS_DIR/$UNAVAILABLE_TASK/meta.yaml" context_provider)" != *"status=unavailable"* ]]; then
  echo "[FAIL] meta context_provider should include status=unavailable"
  exit 1
fi

echo "== Scenario 2: available SocratiCode context is injected =="
create_task "$AVAILABLE_TASK" "Implement order callback validation" "Modify callback code in Games-Labs-Order."
PATH="$TEST_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$AVAILABLE_TASK" dev cursor >/tmp/context-available.log 2>&1
assert_contains "$RUNS_DIR/$AVAILABLE_TASK/.cursor-prompt.md" "status: used" "prompt should record used provider"
assert_contains "$RUNS_DIR/$AVAILABLE_TASK/.cursor-prompt.md" "freshness: current" "prompt should include provider freshness"
assert_contains "$RUNS_DIR/$AVAILABLE_TASK/.cursor-prompt.md" "Fake indexed context for test" "prompt should include indexed context"
if [[ "$(yaml_event_details "$RUNS_DIR/$AVAILABLE_TASK/meta.yaml" context_provider)" != *"status=used"* ]]; then
  echo "[FAIL] meta context_provider should include status=used"
  exit 1
fi

echo "== Scenario 3: empty index falls back and records unknown freshness =="
create_task "$EMPTY_TASK" "Implement order callback validation" "Modify callback code in Games-Labs-Order."
SOCRATICODE_BEHAVIOR=empty PATH="$TEST_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$EMPTY_TASK" dev cursor >/tmp/context-empty.log 2>&1
assert_contains "$RUNS_DIR/$EMPTY_TASK/.cursor-prompt.md" "status: fallback" "empty index should fall back"
assert_contains "$RUNS_DIR/$EMPTY_TASK/.cursor-prompt.md" "freshness: unknown" "empty index should record unknown freshness"
if [[ "$(yaml_event_details "$RUNS_DIR/$EMPTY_TASK/meta.yaml" context_provider)" != *"status=fallback"* ]]; then
  echo "[FAIL] meta context_provider should include status=fallback"
  exit 1
fi

echo "== Scenario 4: pure communication task skips context lookup =="
create_task "$SKIP_TASK" "Draft vendor email" "Write a vendor communication note. No code changes."
PATH="$TEST_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$SKIP_TASK" dev cursor >/tmp/context-skip.log 2>&1
assert_contains "$RUNS_DIR/$SKIP_TASK/.cursor-prompt.md" "status: skipped" "non-code task should skip context provider"
assert_contains "$RUNS_DIR/$SKIP_TASK/.cursor-prompt.md" "not code-impacting" "skip reason should be visible"
if [[ "$(yaml_event_details "$RUNS_DIR/$SKIP_TASK/meta.yaml" context_provider)" != *"status=skipped"* ]]; then
  echo "[FAIL] meta context_provider should include status=skipped"
  exit 1
fi

echo "== Scenario 5: failed provider falls back without failing =="
create_task "$FAIL_TASK" "Implement order callback validation" "Modify callback code in Games-Labs-Order."
SOCRATICODE_BEHAVIOR=fail PATH="$TEST_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$FAIL_TASK" dev cursor >/tmp/context-fail.log 2>&1
assert_contains "$RUNS_DIR/$FAIL_TASK/.cursor-prompt.md" "status: failed" "failed provider should be recorded"
assert_contains "$RUNS_DIR/$FAIL_TASK/.cursor-prompt.md" "fallback: repo_search" "failed provider should fall back"
if [[ "$(yaml_event_details "$RUNS_DIR/$FAIL_TASK/meta.yaml" context_provider)" != *"status=failed"* ]]; then
  echo "[FAIL] meta context_provider should include status=failed"
  exit 1
fi

echo "== Scenario 6: stale index falls back with stale freshness =="
create_task "$STALE_TASK" "Implement order callback validation" "Modify callback code in Games-Labs-Order."
SOCRATICODE_BEHAVIOR=stale PATH="$TEST_BIN_DIR:/usr/bin:/bin" "$RUN_AGENT" "$STALE_TASK" dev cursor >/tmp/context-stale.log 2>&1
assert_contains "$RUNS_DIR/$STALE_TASK/.cursor-prompt.md" "status: fallback" "stale index should fall back"
assert_contains "$RUNS_DIR/$STALE_TASK/.cursor-prompt.md" "freshness: stale" "stale index should record stale freshness"
if [[ "$(yaml_event_details "$RUNS_DIR/$STALE_TASK/meta.yaml" context_provider)" != *"status=fallback"* ]]; then
  echo "[FAIL] meta context_provider should include status=fallback for stale index"
  exit 1
fi

echo "== Scenario 7: validator accepts concise context_sources =="
create_task "$VALIDATE_TASK" "Implement order callback validation" "Modify callback code in Games-Labs-Order."
cat > "$RUNS_DIR/$VALIDATE_TASK/dev-output.yaml" <<'YAML'
summary: "implemented"
artifacts:
  - path: "Games-Labs-Order/internal/example.go"
    action: modified
next_action:
  agent: reviewer
  reason: "ready"
context_sources:
  github:
    branch: ""
    pr: ""
  socraticode:
    status: used
    queries:
      - "dev Implement order callback validation"
    relevant_symbols:
      - "Games-Labs-Order/internal/example.go:Example"
    notes: "Concise context summary only."
blockers: []
YAML
ruby "$ROOT_DIR/validate-yaml.rb" "$VALIDATE_TASK" >/tmp/context-validate.log 2>&1

echo "[PASS] context provider integration scenarios passed"
