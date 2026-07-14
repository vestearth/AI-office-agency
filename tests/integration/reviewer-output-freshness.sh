#!/usr/bin/env bash
set -euo pipefail

# A reviewer can correctly print a new verdict but fail to write the canonical
# artifact. That must never replay a prior changes_requested verdict to Debugger.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_AGENT="$ROOT/run-agent.sh"
RUNS="$ROOT/runs"
TASK="TASK-RF$$"
BIN="$(mktemp -d)"

cleanup() {
  rm -rf "$RUNS/$TASK" "$BIN"
}
trap cleanup EXIT

fail() { echo "[FAIL] $1"; exit 1; }
yaml_value() {
  ruby - "$1" "$2" <<'RUBY'
require "yaml"
require "date"
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
puts ARGV[1].split(".").reduce(data) { |value, key| value.is_a?(Hash) ? value[key] : nil }.to_s
RUBY
}

mkdir -p "$RUNS/$TASK"
cat > "$RUNS/$TASK/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 2
current_agent: reviewer
ready: true
history: []
YAML
cat > "$RUNS/$TASK/task.md" <<'MD'
# Reviewer freshness regression test
MD
cat > "$RUNS/$TASK/reviewer-output.yaml" <<'YAML'
summary: "Old review blocks the task."
artifacts: []
next_action:
  agent: debugger
  reason: "Old blocker."
blockers:
  - "Old blocker"
review_verdict: changes_requested
build_check:
  compile: pass
  tests: pass
  details: "old"
transition:
  from_phase: in_review
  to_phase: debugging
YAML

cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
# Simulates both the original failure and the repaired contract.
if [[ "${WRITE_REVIEWER_OUTPUT:-false}" == "true" ]]; then
  cat > "$REVIEWER_OUTPUT_PATH" <<'YAML'
summary: "Fresh review approves the task."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "fresh"
transition:
  from_phase: in_review
  to_phase: done
YAML
  exit 0
fi

# The correct verdict is visible in the log, but no reviewer-output.yaml is
# written.
cat <<'YAML'
review_verdict: approved
next_action:
  agent: done
YAML
SH
chmod +x "$BIN/codex"

echo "== Reviewer stdout-only verdict must not replay a stale artifact =="
status=0
OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false PATH="$BIN:$PATH" "$RUN_AGENT" "$TASK" reviewer codex >/tmp/reviewer-output-freshness.log 2>&1 || status=$?
[[ "$status" -ne 0 ]] || fail "stdout-only reviewer verdict must fail"
[[ ! -f "$RUNS/$TASK/reviewer-output.yaml" ]] || fail "stale reviewer output must not remain canonical"
ls "$RUNS/$TASK"/reviewer-output.superseded-*.yaml >/dev/null 2>&1 || fail "prior reviewer output was not archived"
[[ "$(yaml_value "$RUNS/$TASK/status.yaml" phase)" == "in_review" ]] || fail "status must not route from stale verdict"
[[ "$(yaml_value "$RUNS/$TASK/status.yaml" current_agent)" == "reviewer" ]] || fail "reviewer must remain the current agent"
grep -q 'review_verdict: approved' /tmp/reviewer-output-freshness.log || fail "test setup did not expose the fresh stdout verdict"

echo "== Fresh reviewer artifact is accepted after the stale one is archived =="
WRITE_REVIEWER_OUTPUT=true REVIEWER_OUTPUT_PATH="$RUNS/$TASK/reviewer-output.yaml" OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false PATH="$BIN:$PATH" "$RUN_AGENT" "$TASK" reviewer codex >/tmp/reviewer-output-freshness-success.log 2>&1
[[ "$(yaml_value "$RUNS/$TASK/status.yaml" phase)" == "done" ]] || fail "fresh reviewer verdict must complete the task"
[[ "$(yaml_value "$RUNS/$TASK/status.yaml" current_agent)" == "done" ]] || fail "fresh reviewer verdict must route to done"
[[ "$(yaml_value "$RUNS/$TASK/reviewer-output.yaml" review_verdict)" == "approved" ]] || fail "canonical reviewer output must contain the fresh verdict"

echo "[PASS] reviewer output freshness guard prevents replay and accepts a fresh verdict"
