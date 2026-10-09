#!/usr/bin/env bash
set -euo pipefail

# Slice 2 — producer contract enforcement.
# Verifies enforce-output-contract.rb routes invalid agent output to
# validation_failed (atomic) and leaves valid output untouched.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ENFORCE="$ROOT_DIR/scripts/enforce-output-contract.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-901"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"

cleanup() { rm -rf "$TMP_RUNS"; }
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

assert_eq() {
  if [[ "$1" != "$2" ]]; then
    echo "[FAIL] $3: expected '$1' got '$2'"
    exit 1
  fi
}

phase_of() {
  ruby - "$1" <<'RUBY'
require "yaml"; require "date"
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
puts data["phase"].to_s
RUBY
}

write_status() {
  cat > "$TASK_DIR/status.yaml" <<YAML
task_id: $TASK
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
YAML
}

write_valid_reviewer() {
  cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Reviewed and approved."
artifacts: []
next_action:
  agent: done
  reason: "Approved."
blockers: []
review_verdict: approved
build_check:
  compile: pass
  tests: pass
  details: "all green"
YAML
}

write_invalid_reviewer() {
  cat > "$TASK_DIR/reviewer-output.yaml" <<'YAML'
summary: "Reviewed."
artifacts: []
next_action:
  agent: done
  reason: "x"
blockers: []
review_verdict: totally_bogus_verdict
build_check:
  compile: pass
  tests: pass
  details: "x"
YAML
}

# --- Case 1: valid output -> exit 0, phase untouched ---
write_status
write_valid_reviewer
if ruby "$ENFORCE" "$TASK" reviewer; then
  assert_eq "in_review" "$(phase_of "$TASK_DIR/status.yaml")" "valid output keeps phase"
else
  echo "[FAIL] valid output should exit 0"
  exit 1
fi

# --- Case 2: invalid output -> exit 1, phase = validation_failed ---
write_status
write_invalid_reviewer
if ruby "$ENFORCE" "$TASK" reviewer; then
  echo "[FAIL] invalid output should exit non-zero"
  exit 1
else
  assert_eq "validation_failed" "$(phase_of "$TASK_DIR/status.yaml")" "invalid output sets validation_failed"
fi

# --- Case 3: agent not in manifest -> pass-through (exit 0) ---
write_status
if ruby "$ENFORCE" "$TASK" planner; then
  assert_eq "in_review" "$(phase_of "$TASK_DIR/status.yaml")" "unmanifested agent is not enforced"
else
  echo "[FAIL] unmanifested agent should pass through with exit 0"
  exit 1
fi

SUITE_DONE=1
echo "[PASS] output-contract: validation_failed routing works"
