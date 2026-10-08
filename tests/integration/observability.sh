#!/usr/bin/env bash
# N1/N3/N4/N5 — observability:
#  N1: every transition records an ISO-8601 `at` timestamp in history.
#  N3: validation_failed keeps the specific validator error, not a generic line.
#  N4: the runtime validator checks the shape of history.
#  N5: `status` shows the recent transitions (why), not just the current phase.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
# The extracted run-agent.sh functions are thin wrappers around
# ruby "$OFFICE_DIR/scripts/<x>.rb" (#23 Phase 2.1), so they need it set.
OFFICE_DIR="$ROOT"
ENFORCE="$ROOT/scripts/enforce-output-contract.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
RUNS_DIR="$ROOT/runs"
WORK="$(mktemp -d)"; TN4="TASK-N4$$"; TN5="TASK-N5$$"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
finish() {
  local rc=$?
  rm -rf "$@"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap 'finish "$WORK" "$RUNS_DIR/$TN4" "$RUNS_DIR/$TN5"' EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }
last_history() { ruby -ryaml -e 'h=(YAML.safe_load(File.read(ARGV[0]))||{})["history"]||[]; e=h.last||{}; puts((e[ARGV[1]]).to_s)' "$1" "$2"; }

# ── N1: a transition records an `at` timestamp ────────────────────────────────
awk '/^sync_status_from_output\(\) \{/{f=1} f{print} f && $0=="}"{exit}' "$DRIVER" > "$WORK/sync.sh"
# shellcheck disable=SC1090
source "$WORK/sync.sh"
mkdir -p "$WORK/n1"
cat > "$WORK/n1/status.yaml" <<'Y'
task_id: TASK-N1
phase: assigned
state: assigned
iteration: 0
current_agent: dev
history: []
Y
cat > "$WORK/n1/out.yaml" <<'Y'
summary: implemented
next_action:
  agent: reviewer
  reason: ready
Y
sync_status_from_output TASK-N1 dev "$WORK/n1/status.yaml" "$WORK/n1/out.yaml" 2026-01-01 in_review >/dev/null
[[ "$(last_history "$WORK/n1/status.yaml" at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "N1: history entry must carry an ISO-8601 'at' timestamp"
ok "N1: transition records an ISO-8601 'at' timestamp"

# ── N3: validation_failed keeps the specific validator error ──────────────────
export AI_OFFICE_RUNS_DIR="$WORK/runs"
TD="$WORK/runs/TASK-N3"; mkdir -p "$TD"
cat > "$TD/status.yaml" <<'Y'
task_id: TASK-N3
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
history: []
Y
cat > "$TD/reviewer-output.yaml" <<'Y'
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
Y
ruby "$ENFORCE" TASK-N3 reviewer >/dev/null 2>&1 || true
last_history "$TD/status.yaml" reason | grep -q "review_verdict" || fail "N3: validation_failed reason should include the specific validator message"
ok "N3: validation_failed history keeps the specific schema error"
unset AI_OFFICE_RUNS_DIR

# ── N4: the validator checks the shape of history ─────────────────────────────
mkdir -p "$RUNS_DIR/$TN4"
cat > "$RUNS_DIR/$TN4/status.yaml" <<YAML
task_id: $TN4
phase: assigned
state: assigned
iteration: 0
current_agent: dev
history:
  - phase: "x -> y"
    agent: dev
YAML
out="$(ruby "$VALIDATOR" "$TN4" 2>&1)" || true
echo "$out" | grep -qi "history" || { echo "$out"; fail "N4: validator should flag the malformed history (missing reason)"; }
ok "N4: validator flags a malformed history entry"

# ── N5: `status` shows recent transitions ─────────────────────────────────────
mkdir -p "$RUNS_DIR/$TN5"
cat > "$RUNS_DIR/$TN5/status.yaml" <<YAML
task_id: $TN5
phase: in_review
state: in_review
iteration: 2
current_agent: reviewer
history:
  - phase: "assigned -> in_review"
    agent: dev
    reason: "implemented the feature"
    at: "2026-06-05T10:00:00Z"
YAML
out="$("$DRIVER" status "$TN5" 2>&1)" || true
echo "$out" | grep -q "Recent:" || { echo "$out"; fail "N5: status should print a Recent section"; }
echo "$out" | grep -q "implemented the feature" || fail "N5: status should show the last transition reason"
ok "N5: status shows the recent transition reasons"

SUITE_DONE=1
echo "[PASS] observability (N1 + N3 + N4 + N5)"
