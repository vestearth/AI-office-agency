#!/usr/bin/env bash
# S3/S4/S5 — a human decision must not be silently droppable (S3), re-appliable
# forever (S4), or ignored by the agent the driver actually dispatches (S5).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/reconcile-decision.rb"
DRIVER="$ROOT/run-agent.sh"
RUNS_DIR="$ROOT/runs"
WORK="$(mktemp -d)"; BIN="$(mktemp -d)"; CALL="$(mktemp -d)"
T_S5="TASK-S5$$"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  rm -rf "$WORK" "$BIN" "$CALL" "$RUNS_DIR/$T_S5"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
yval() { ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
path, key = ARGV
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts key.split(".").reduce(d) { |m, p| m.is_a?(Hash) ? m[p] : nil }.to_s
RUBY
}

export AI_OFFICE_RUNS_DIR="$WORK/runs"

# ── S3: a malformed decision.yaml is surfaced (exit 3), not silently dropped ───
TD="$WORK/runs/TASK-S3"; mkdir -p "$TD"
cat > "$TD/status.yaml" <<'Y'
task_id: TASK-S3
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
Y
printf 'decisions: [unterminated\n' > "$TD/decision.yaml"
rc=0; ruby "$RECONCILE" TASK-S3 >/dev/null 2>"$WORK/s3.err" || rc=$?
[[ "$rc" -eq 3 ]] || fail "S3: malformed decision.yaml should exit 3, got $rc"
grep -qi "malformed" "$WORK/s3.err" || fail "S3: should warn about the malformed decision.yaml"
rm "$TD/decision.yaml"   # absent -> legit noop
rc=0; out="$(ruby "$RECONCILE" TASK-S3 2>/dev/null)" || rc=$?
[[ "$rc" -eq 0 && "$out" == "noop" ]] || fail "S3: absent decision.yaml should noop (rc=$rc out=$out)"
ok "S3: malformed decision.yaml surfaced (exit 3); absent = noop"

# ── S4: a decision without decided_at is skipped, never applied/re-applied ─────
TD4="$WORK/runs/TASK-S4"; mkdir -p "$TD4"
cat > "$TD4/status.yaml" <<'Y'
task_id: TASK-S4
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
Y
cat > "$TD4/decision.yaml" <<'Y'
task_id: TASK-S4
decisions:
  - decision: request_changes
    actor: alice
Y
out="$(ruby "$RECONCILE" TASK-S4 2>"$WORK/s4.err")" || true
[[ "$out" == "noop" ]] || fail "S4: decision without decided_at must noop, got '$out'"
grep -qi "decided_at" "$WORK/s4.err" || fail "S4: should warn about the missing decided_at"
[[ "$(yval "$TD4/status.yaml" phase)" == "in_review" ]] || fail "S4: status must be untouched"
[[ -z "$(yval "$TD4/status.yaml" decision_applied_at)" ]] || fail "S4: must not stamp an empty decision_applied_at"
ok "S4: decision without decided_at is skipped (no apply, no empty applied_at)"

# ── S5: a non-terminal decision dispatches the routed agent, not the CLI one ───
# The driver (and the reconcile it shells out to) must use the REAL runs dir, so
# drop the S3/S4 override or reconcile would noop on a task it can't find.
unset AI_OFFICE_RUNS_DIR
cat > "$BIN/codex" <<'SH'
#!/usr/bin/env bash
c="$S5_CALL/codex.count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"; exit 0
SH
chmod +x "$BIN/codex"
mkdir -p "$RUNS_DIR/$T_S5"
cat > "$RUNS_DIR/$T_S5/status.yaml" <<YAML
task_id: $T_S5
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
cat > "$RUNS_DIR/$T_S5/decision.yaml" <<YAML
task_id: $T_S5
decisions:
  - decision: request_changes
    actor: alice
    decided_at: "2026-06-05T10:00:00Z"
YAML
echo "# t" > "$RUNS_DIR/$T_S5/task.md"
out="$(S5_CALL="$CALL" PATH="$BIN:$PATH" "$DRIVER" "$T_S5" reviewer codex 2>&1)" || true
echo "$out" | grep -q "dispatching that instead of 'reviewer'" || { echo "$out"; fail "S5: should re-align dispatch to the decision's agent"; }
[[ "$(yval "$RUNS_DIR/$T_S5/status.yaml" phase)" == "debugging" ]] || fail "S5: request_changes should set phase=debugging"
[[ "$(yval "$RUNS_DIR/$T_S5/status.yaml" current_agent)" == "debugger" ]] || fail "S5: current_agent should be debugger"
ok "S5: non-terminal decision dispatches the routed agent (debugger), not the CLI agent"

SUITE_DONE=1
echo "[PASS] decision-path-integrity (S3 + S4 + S5)"
