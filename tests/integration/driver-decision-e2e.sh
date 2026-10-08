#!/usr/bin/env bash
set -euo pipefail

# End-to-end driver test: exercises the real run-agent.sh dispatch path through
# the new gates added this cycle — the output-contract enforcement (Slice 2) and
# the human-decision reconcile + terminal-stop (#1) — using a fake codex runner.
# Isolated Ruby tests cover the helpers; this proves the bash wiring.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
T_VALID="TASK-${SUFFIX}1"
T_INVALID="TASK-${SUFFIX}2"
T_DECISION="TASK-${SUFFIX}3"
BIN="$(mktemp -d)"
CALL="$(mktemp -d)"

cleanup() {
  rm -rf "$RUNS_DIR/$T_VALID" "$RUNS_DIR/$T_INVALID" "$RUNS_DIR/$T_DECISION" "$BIN" "$CALL"
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
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

yaml_value() {
  ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
path, key = ARGV
data = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts key.split(".").reduce(data) { |m, p| m.is_a?(Hash) ? m[p] : nil }.to_s
RUBY
}

# Fake codex: succeeds and counts invocations (so we can prove a terminal
# decision stops BEFORE dispatch).
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$DRIVER_E2E_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"
echo $((n + 1)) > "$c"
exit 0
SH
chmod +x "$BIN/codex"

codex_calls() { [[ -f "$CALL/codex.count" ]] && cat "$CALL/codex.count" || echo 0; }

write_assigned_dev() {  # <task_id>
  mkdir -p "$RUNS_DIR/$1"
  cat > "$RUNS_DIR/$1/status.yaml" <<YAML
task_id: $1
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
  cat > "$RUNS_DIR/$1/pm-output.yaml" <<'YAML'
summary: "plan"
artifacts: []
next_action: { agent: dev, reason: "implement" }
blockers: []
YAML
}

write_valid_dev_output() {  # <task_id>
  cat > "$RUNS_DIR/$1/dev-output.yaml" <<'YAML'
summary: "implemented the thing"
artifacts:
  - path: "foo.go"
    action: modified
next_action: { agent: reviewer, reason: "ready for review" }
blockers: []
YAML
}

write_invalid_dev_output() {  # <task_id> — next_action.agent off-contract
  cat > "$RUNS_DIR/$1/dev-output.yaml" <<'YAML'
summary: "implemented the thing"
artifacts:
  - path: "foo.go"
    action: modified
next_action: { agent: banana, reason: "ready for review" }
blockers: []
YAML
}

# ── Scenario 1: valid output → enforce passes → sync to in_review ───────────────
echo "== Scenario 1: valid output dispatches and syncs =="
write_assigned_dev "$T_VALID"
write_valid_dev_output "$T_VALID"
DRIVER_E2E_CALL="$CALL" PATH="$BIN:$PATH" "$RUN_AGENT" "$T_VALID" dev codex >/tmp/driver-e2e-1.log 2>&1
assert_eq "in_review" "$(yaml_value "$RUNS_DIR/$T_VALID/status.yaml" phase)" "valid output should sync to in_review"
[[ "$(codex_calls)" -ge 1 ]] || { echo "[FAIL] codex should have been dispatched"; exit 1; }

# ── Scenario 2: invalid output → validation_failed (not propagated) ─────────────
echo "== Scenario 2: invalid output routes to validation_failed =="
rm -f "$CALL/codex.count"
write_assigned_dev "$T_INVALID"
write_invalid_dev_output "$T_INVALID"
DRIVER_E2E_CALL="$CALL" PATH="$BIN:$PATH" "$RUN_AGENT" "$T_INVALID" dev codex >/tmp/driver-e2e-2.log 2>&1 || true
assert_eq "validation_failed" "$(yaml_value "$RUNS_DIR/$T_INVALID/status.yaml" phase)" "invalid output should set validation_failed"
[[ "$(codex_calls)" -ge 1 ]] || { echo "[FAIL] codex should have run before enforce caught the bad output"; exit 1; }

# ── Scenario 3: pending decision → reconcile + terminal-stop (no dispatch) ──────
echo "== Scenario 3: human approve reconciles to done and stops dispatch =="
rm -f "$CALL/codex.count"
mkdir -p "$RUNS_DIR/$T_DECISION"
cat > "$RUNS_DIR/$T_DECISION/status.yaml" <<YAML
task_id: $T_DECISION
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
cat > "$RUNS_DIR/$T_DECISION/decision.yaml" <<YAML
task_id: $T_DECISION
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-06-05T10:00:00Z"
YAML
DRIVER_E2E_CALL="$CALL" PATH="$BIN:$PATH" "$RUN_AGENT" "$T_DECISION" reviewer codex >/tmp/driver-e2e-3.log 2>&1
assert_eq "done" "$(yaml_value "$RUNS_DIR/$T_DECISION/status.yaml" phase)" "approve decision should reconcile to done"
assert_eq "2026-06-05T10:00:00Z" "$(yaml_value "$RUNS_DIR/$T_DECISION/status.yaml" decision_applied_at)" "decision_applied_at recorded"
assert_eq "0" "$(codex_calls)" "terminal decision must stop BEFORE dispatching the runner"

SUITE_DONE=1
echo "[PASS] driver-decision-e2e: enforce gate + decision reconcile + terminal-stop"
