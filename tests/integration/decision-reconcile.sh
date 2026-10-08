#!/usr/bin/env bash
set -euo pipefail

# #1 — Driver acts on a human decision: reconcile-decision.rb maps the latest
# decision.yaml entry into a status.yaml transition, idempotently.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RECONCILE="$ROOT_DIR/scripts/reconcile-decision.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-902"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  rm -rf "$TMP_RUNS"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

assert_eq() {
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

phase_of() {
  ruby - "$1" <<'RUBY'
require "yaml"; require "date"
d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
puts d["phase"].to_s
RUBY
}
applied_of() {
  ruby - "$1" <<'RUBY'
require "yaml"; require "date"
d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
puts d["decision_applied_at"].to_s
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

write_decision() {  # <action> <decided_at>
  cat > "$TASK_DIR/decision.yaml" <<YAML
task_id: $TASK
decisions:
  - decision: $1
    actor: alice
    decided_at: "$2"
YAML
}

# --- no decision.yaml -> noop ---
write_status
assert_eq "noop" "$(ruby "$RECONCILE" "$TASK")" "no decision file is noop"

# --- request_changes -> debugging ---
write_decision request_changes "2026-06-05T01:00:00Z"
assert_eq "applied:request_changes:debugging" "$(ruby "$RECONCILE" "$TASK")" "request_changes applies"
assert_eq "debugging" "$(phase_of "$TASK_DIR/status.yaml")" "phase -> debugging"
assert_eq "2026-06-05T01:00:00Z" "$(applied_of "$TASK_DIR/status.yaml")" "decision_applied_at recorded"

# --- idempotent: same decision again -> noop, phase unchanged ---
assert_eq "noop" "$(ruby "$RECONCILE" "$TASK")" "re-applying same decision is noop"
assert_eq "debugging" "$(phase_of "$TASK_DIR/status.yaml")" "phase stays debugging"

# --- a NEW decision (different decided_at) applies again ---
write_decision approve "2026-06-05T02:00:00Z"
# decision.yaml now has one entry; but append semantics: latest is approve.
assert_eq "applied:approve:done" "$(ruby "$RECONCILE" "$TASK")" "newer decision applies"
assert_eq "done" "$(phase_of "$TASK_DIR/status.yaml")" "phase -> done"

# --- reject -> aborted ---
write_status
write_decision reject "2026-06-05T03:00:00Z"
assert_eq "applied:reject:aborted" "$(ruby "$RECONCILE" "$TASK")" "reject applies"
assert_eq "aborted" "$(phase_of "$TASK_DIR/status.yaml")" "phase -> aborted"

# --- resulting status.yaml is contract-valid ---
ruby "$ROOT_DIR/validate-yaml.rb" "$TASK_DIR/status.yaml" >/dev/null || { echo "[FAIL] reconciled status invalid"; exit 1; }

SUITE_DONE=1
echo "[PASS] decision-reconcile: transitions + idempotency + valid status"
